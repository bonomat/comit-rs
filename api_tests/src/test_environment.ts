import { Config } from "@jest/types";
import { execAsync, existsAsync, HarnessGlobal } from "./utils";
import { promises as asyncFs } from "fs";
import NodeEnvironment from "jest-environment-node";
import path from "path";
import { LightningWallet } from "./wallets/lightning";
import { BitcoinWallet } from "./wallets/bitcoin";
import { AssetKind } from "./asset";
import { LedgerKind } from "./ledgers/ledger";
import { BitcoindInstance } from "./ledgers/bitcoind_instance";
import { configure, Logger, shutdown as loggerShutdown } from "log4js";
import { EnvironmentContext } from "@jest/environment";
import ledgerLock from "./ledgers/ledger_lock";
import BitcoinMinerInstance from "./ledgers/bitcoin_miner_instance";
import { EthereumWallet } from "./wallets/ethereum";
import { LedgerInstance, LightningNodeConfig } from "./ledgers";
import { GethInstance } from "./ledgers/geth_instance";
import { LndInstance } from "./ledgers/lnd_instance";
import BitcoinRpcClient from "bitcoin-core";

export default class TestEnvironment extends NodeEnvironment {
    private readonly testSuite: string;
    private readonly ledgers: string[];
    private readonly logDir: string;
    private readonly locksDir: string;
    private readonly nodeModulesBinDir: string;
    private readonly srcDir: string;

    public global: HarnessGlobal;

    private logger: Logger;

    constructor(config: Config.ProjectConfig, context: EnvironmentContext) {
        super(config);

        this.ledgers = TestEnvironment.extractLedgersToBeStarted(
            context.docblockPragmas
        );
        this.logDir = path.resolve(config.rootDir, "log");
        this.locksDir = path.resolve(config.rootDir, "locks");
        this.nodeModulesBinDir = path.resolve(
            config.rootDir,
            "node_modules",
            ".bin"
        );
        this.srcDir = path.resolve(config.rootDir, "src");
        this.testSuite = path.parse(context.testPath).name;
    }

    async setup() {
        await super.setup();

        const cargoTargetDir = await execAsync(
            "cargo metadata --format-version=1 --no-deps"
        )
            .then(({ stdout }) => JSON.parse(stdout))
            .then((metadata) => metadata.target_directory);

        // setup global variables
        this.global.ledgerConfigs = {};
        this.global.lndWallets = {};
        this.global.cargoTargetDir = cargoTargetDir;

        const log4js = configure({
            appenders: {
                multi: {
                    type: "multiFile",
                    base: this.logDir,
                    property: "categoryName",
                    extension: ".log",
                    layout: {
                        type: "pattern",
                        pattern: "%d %5.10p: %m",
                    },
                    timeout: 2000,
                },
            },
            categories: {
                default: { appenders: ["multi"], level: "debug" },
            },
        });

        const testLogDir = path.join(this.logDir, "tests", this.testSuite);
        await asyncFs.mkdir(testLogDir, { recursive: true });

        this.global.getLogFile = (pathElements) =>
            path.join(testLogDir, ...pathElements);
        this.global.getLogger = (categories) => {
            return log4js.getLogger(
                path.join("tests", this.testSuite, ...categories)
            );
        };
        this.logger = this.global.getLogger(["test_environment"]);

        this.global.getDataDir = async (program) => {
            const dir = path.join(this.logDir, program);
            await asyncFs.mkdir(dir, { recursive: true });

            return dir;
        };
        this.global.gethLockDir = await this.getLockDirectory("geth");

        this.logger.info("Starting up test environment");

        await this.startLedgers();
    }

    async teardown() {
        await super.teardown();

        loggerShutdown();
    }

    /**
     * Initializes all required ledgers with as much parallelism as possible.
     */
    private async startLedgers() {
        const startEthereum = this.ledgers.includes("ethereum");
        const startBitcoin = this.ledgers.includes("bitcoin");
        const startLightning = this.ledgers.includes("lightning");

        const tasks = [];

        if (startEthereum) {
            tasks.push(this.startEthereum());
        }

        if (startBitcoin && !startLightning) {
            tasks.push(this.startBitcoin());
        }

        if (startLightning) {
            tasks.push(this.startBitcoinAndLightning());
        }

        await Promise.all(tasks);
    }

    /**
     * Start the Bitcoin Ledger
     *
     * Once this function returns, the necessary configuration values have been set inside the test environment.
     */
    private async startBitcoin() {
        const lockDir = await this.getLockDirectory("bitcoind");
        const release = await ledgerLock(lockDir);

        const bitcoind = await BitcoindInstance.new(
            await this.global.getDataDir("bitcoind"),
            path.join(lockDir, "bitcoind.pid"),
            this.logger
        );
        const config = await this.startLedger(
            lockDir,
            bitcoind,
            async (bitcoind) => {
                const config = bitcoind.config;
                const rpcClient = new BitcoinRpcClient({
                    network: config.network,
                    port: config.rpcPort,
                    host: config.host,
                    username: config.username,
                    password: config.password,
                });

                const name = "miner";
                await rpcClient.createWallet(name);

                this.logger.info(`Created miner wallet with name ${name}`);

                return { ...bitcoind.config, minerWallet: name };
            }
        );

        const minerPidFile = path.join(lockDir, "miner.pid");

        try {
            await existsAsync(minerPidFile);
        } catch (e) {
            // miner is not running
            const tsNode = path.join(this.nodeModulesBinDir, "ts-node");
            const minerProgram = path.join(this.srcDir, "bitcoin_miner.ts");

            await BitcoinMinerInstance.start(
                tsNode,
                minerProgram,
                path.join(lockDir, "config.json"),
                minerPidFile,
                this.logger
            );
        }

        this.global.ledgerConfigs.bitcoin = config;

        await release();
    }

    /**
     * Start the Ethereum Ledger
     *
     * Once this function returns, the necessary configuration values have been set inside the test environment.
     */
    private async startEthereum() {
        const lockDir = await this.getLockDirectory("geth");
        const release = await ledgerLock(lockDir);

        const geth = await GethInstance.new(
            await this.global.getDataDir("geth"),
            path.join(lockDir, "geth.pid"),
            this.logger
        );
        const config = await this.startLedger(lockDir, geth, async (geth) => {
            const rpcUrl = geth.rpcUrl;
            const devAccountKey = geth.devAccountKey();
            const erc20Wallet = await EthereumWallet.new_instance(
                devAccountKey,
                rpcUrl,
                this.logger,
                lockDir,
                geth.CHAIN_ID
            );
            const erc20TokenContract = await erc20Wallet.deployErc20TokenContract();

            this.logger.info(
                "ERC20 token contract deployed at",
                erc20TokenContract
            );

            return {
                rpc_url: rpcUrl,
                tokenContract: erc20TokenContract,
                dev_account_key: devAccountKey,
                chain_id: geth.CHAIN_ID,
            };
        });

        this.global.ledgerConfigs.ethereum = config;
        this.global.tokenContract = config.tokenContract;

        await release();
    }

    /**
     * First starts the Bitcoin and then the Lightning ledgers.
     *
     * The Lightning ledgers depend on Bitcoin to be up and running.
     */
    private async startBitcoinAndLightning() {
        await this.startBitcoin();

        // Lightning nodes can be started in parallel
        await Promise.all([
            this.startAliceLightning(),
            this.startBobLightning(),
        ]);

        await this.setupLightningChannels();
    }

    private async setupLightningChannels() {
        const { alice, bob } = this.global.lndWallets;

        const alicePeers = await alice.listPeers();
        const bobPubkey = await bob.inner.getPubkey();

        if (!alicePeers.find((peer) => peer.pubKey === bobPubkey)) {
            await alice.connectPeer(bob);
        }

        await alice.mint({
            name: AssetKind.Bitcoin,
            ledger: LedgerKind.Lightning,
            quantity: "15000000",
        });

        await bob.mint({
            name: AssetKind.Bitcoin,
            ledger: LedgerKind.Lightning,
            quantity: "15000000",
        });

        await alice.openChannel(bob, 15000000);
        await bob.openChannel(alice, 15000000);
    }

    /**
     * Start the Lightning Ledger for Alice
     *
     * This function assumes that the Bitcoin ledger is initialized.
     * Once this function returns, the necessary configuration values have been set inside the test environment.
     */
    private async startAliceLightning() {
        const config = await this.initLightningLedger("lnd-alice");
        this.global.lndWallets.alice = await this.initLightningWallet(config);
        this.global.ledgerConfigs.aliceLnd = config;
    }

    /**
     * Start the Lightning Ledger for Bob
     *
     * This function assumes that the Bitcoin ledger is initialized.
     * Once this function returns, the necessary configuration values have been set inside the test environment.
     */
    private async startBobLightning() {
        const config = await this.initLightningLedger("lnd-bob");
        this.global.lndWallets.bob = await this.initLightningWallet(config);
        this.global.ledgerConfigs.bobLnd = config;
    }

    private async initLightningWallet(config: LightningNodeConfig) {
        return LightningWallet.newInstance(
            await BitcoinWallet.newInstance(
                this.global.ledgerConfigs.bitcoin,
                this.logger
            ),
            this.logger,
            config
        );
    }

    private async initLightningLedger(
        role: string
    ): Promise<LightningNodeConfig> {
        const lockDir = await this.getLockDirectory(role);
        const release = await ledgerLock(lockDir);

        const lnd = await LndInstance.new(
            await this.global.getDataDir(role),
            this.logger,
            await this.global.getDataDir("bitcoind"),
            path.join(lockDir, "lnd.pid")
        );

        const config = await this.startLedger(
            lockDir,
            lnd,
            async (lnd) => lnd.config
        );

        await release();

        return config;
    }

    private async startLedger<C, S extends LedgerInstance>(
        lockDir: string,
        instance: S,
        makeConfig: (instance: S) => Promise<C>
    ): Promise<C> {
        const configFile = path.join(lockDir, "config.json");

        this.logger.info("Checking for config file ", configFile);

        try {
            await existsAsync(configFile);

            this.logger.info(
                "Found config file, we'll be using that configuration instead of starting another instance"
            );

            const config = await asyncFs.readFile(configFile, {
                encoding: "utf-8",
            });

            return JSON.parse(config);
        } catch (e) {
            this.logger.info("No config file found, starting ledger");

            await instance.start();

            const config = await makeConfig(instance);

            await asyncFs.writeFile(configFile, JSON.stringify(config), {
                encoding: "utf-8",
            });

            this.logger.info("Config file written to", configFile);

            return config;
        }
    }

    private async getLockDirectory(process: string): Promise<string> {
        const dir = path.join(this.locksDir, process);

        await asyncFs.mkdir(dir, {
            recursive: true,
        });

        return dir;
    }

    private static extractLedgersToBeStarted(
        docblockPragmas: Record<string, string | string[]>
    ): string[] {
        const ledgersToStart = docblockPragmas.ledger;

        if (!ledgersToStart) {
            return [];
        }

        if (typeof ledgersToStart === "string") {
            return [ledgersToStart];
        }

        return ledgersToStart;
    }
}

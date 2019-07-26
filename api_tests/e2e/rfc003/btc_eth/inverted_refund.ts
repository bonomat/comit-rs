import { expect } from "chai";
import "chai/register-should";
import { toBN, toWei } from "web3-utils";
import { Actor } from "../../../lib/actor";
import * as bitcoin from "../../../lib/bitcoin";
import { ActionKind, SwapRequest } from "../../../lib/comit";
import "../../../lib/setup_chai";
import { createTests, Step } from "../../../lib/test_creator";
import { HarnessGlobal } from "../../../lib/util";

declare var global: HarnessGlobal;

(async function() {
    const alice = new Actor("alice", global.config, global.project_root, {
        ethereumNodeConfig: global.ledgers_config.ethereum,
        bitcoinNodeConfig: global.ledgers_config.bitcoin,
        addressForIncomingBitcoinPayments:
            "bcrt1qs2aderg3whgu0m8uadn6dwxjf7j3wx97kk2qqtrum89pmfcxknhsf89pj0",
    });
    const bob = new Actor("bob", global.config, global.project_root, {
        ethereumNodeConfig: global.ledgers_config.ethereum,
        bitcoinNodeConfig: global.ledgers_config.bitcoin,
        addressForIncomingBitcoinPayments: null,
    });

    const alphaAssetQuantity = 100000000;
    const betaAssetQuantity = toBN(toWei("10", "ether"));

    const alphaExpiry = Math.round(Date.now() / 1000) + 13;
    const betaExpiry = Math.round(Date.now() / 1000) + 8;

    await bitcoin.ensureFunding();
    await bob.wallet.eth().fund("11");
    await alice.wallet.eth().fund("0.1");
    await alice.wallet.btc().fund(10);
    await bitcoin.generate();

    const swapRequest: SwapRequest = {
        alpha_ledger: {
            name: "bitcoin",
            network: "regtest",
        },
        beta_ledger: {
            name: "ethereum",
            network: "regtest",
        },
        alpha_asset: {
            name: "bitcoin",
            quantity: alphaAssetQuantity.toString(),
        },
        beta_asset: {
            name: "ether",
            quantity: betaAssetQuantity.toString(),
        },
        beta_ledger_redeem_identity: alice.wallet.eth().address(),
        alpha_expiry: alphaExpiry,
        beta_expiry: betaExpiry,
        peer: await bob.peerId(),
    };

    const steps: Step[] = [
        {
            actor: bob,
            action: ActionKind.Accept,
            waitUntil: state => state.communication.status === "ACCEPTED",
        },
        {
            actor: alice,
            action: ActionKind.Fund,
            waitUntil: state => state.alpha_ledger.status === "Funded",
        },
        {
            actor: bob,
            action: ActionKind.Fund,
            waitUntil: state =>
                state.alpha_ledger.status === "Funded" &&
                state.beta_ledger.status === "Funded",
        },
        {
            actor: alice,
            action: ActionKind.Refund,
            waitUntil: state => state.alpha_ledger.status === "Refunded",
        },
        {
            actor: bob,
            waitUntil: state => state.alpha_ledger.status === "Refunded",
        },
        {
            actor: alice,
            test: {
                description: "Should see that beta is still funded",
                callback: async body => {
                    const status = body.properties.state.beta_ledger.status;

                    expect(status).to.equal("Funded");
                },
            },
        },
        {
            actor: bob,
            test: {
                description: "Should see that beta is still funded",
                callback: async body => {
                    const status = body.properties.state.beta_ledger.status;

                    expect(status).to.equal("Funded");
                },
            },
        },
        {
            actor: bob,
            action: ActionKind.Refund,
            waitUntil: state => state.beta_ledger.status === "Refunded",
        },
        {
            actor: alice,
            waitUntil: state => state.beta_ledger.status === "Refunded",
        },
    ];

    describe("RFC003: Alice can refund before Bob", async () => {
        createTests(alice, bob, steps, "/swaps/rfc003", "/swaps", swapRequest);
    });
    run();
})();
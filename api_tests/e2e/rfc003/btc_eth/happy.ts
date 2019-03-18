import * as bitcoin from "../../../lib/bitcoin";
import * as chai from "chai";
import * as ethereum from "../../../lib/ethereum";
import { Actor } from "../../../lib/actor";
import {
    AcceptPayload,
    Action,
    SwapsResponse,
    SwapResponse,
} from "../../../lib/comit";
import { BN, toWei, toBN } from "web3-utils";
import { HarnessGlobal } from "../../../lib/util";

import chaiHttp = require("chai-http");

const should = chai.should();
chai.use(chaiHttp);

declare var global: HarnessGlobal;

const bob_initial_eth = "11";
const alice_initial_eth = "0.1";

const alice = new Actor("alice", global.config, global.test_root, {
    ethConfig: global.ledgers_config.ethereum,
    btcConfig: global.ledgers_config.bitcoin,
});
const bob = new Actor("bob", global.config, global.test_root, {
    ethConfig: global.ledgers_config.ethereum,
    btcConfig: global.ledgers_config.bitcoin,
});

const alice_final_address = "0x03a329c0248369a73afac7f9381e02fb43d2ea72";
const bob_final_address =
    "bcrt1qs2aderg3whgu0m8uadn6dwxjf7j3wx97kk2qqtrum89pmfcxknhsf89pj0";
const bob_comit_node_address = bob.comitNodeConfig.comit.comit_listen;

const alpha_asset_quantity = 100000000;
const beta_asset_quantity = toBN(toWei("10", "ether"));
const alpha_max_fee = 5000; // Max 5000 satoshis fee

const alpha_expiry = new Date("2080-06-11T23:00:00Z").getTime() / 1000;
const beta_expiry = new Date("2080-06-11T13:00:00Z").getTime() / 1000;

describe("RFC003: Bitcoin for Ether", () => {
    before(async function() {
        this.timeout(5000);
        await bitcoin.ensureSegwit();
        await bob.wallet.eth().fund(bob_initial_eth);
        await alice.wallet.eth().fund(alice_initial_eth);
        await alice.wallet.btc().fund(10);
        await bitcoin.generate();
    });

    let swap_location: string;
    let alice_swap_href: string;

    it("[Alice] Should be able to make first swap request via HTTP api", async () => {
        await chai
            .request(alice.comit_node_url())
            .post("/swaps/rfc003")
            .send({
                alpha_ledger: {
                    name: "Bitcoin",
                    network: "regtest",
                },
                beta_ledger: {
                    name: "Ethereum",
                    network: "regtest",
                },
                alpha_asset: {
                    name: "Bitcoin",
                    quantity: alpha_asset_quantity.toString(),
                },
                beta_asset: {
                    name: "Ether",
                    quantity: beta_asset_quantity.toString(),
                },
                beta_ledger_redeem_identity: alice_final_address,
                alpha_expiry: alpha_expiry,
                beta_expiry: beta_expiry,
                peer: bob_comit_node_address,
            })
            .then(res => {
                res.should.have.status(201);
                swap_location = res.header.location;
                swap_location.should.be.a("string");
                alice_swap_href = swap_location;
            });
    });

    it("[Alice] Should be in IN_PROGRESS and SENT after sending the swap request to Bob", async function() {
        this.timeout(10000);
        await alice.poll_comit_node_until(
            alice_swap_href,
            body =>
                body.status === "IN_PROGRESS" &&
                body.state.communication.status === "SENT"
        );
    });

    let bob_swap_href: string;

    it("[Bob] Shows the Swap as IN_PROGRESS in /swaps", async () => {
        let body: any = (await bob.poll_comit_node_until(
            "/swaps",
            body => body._embedded.swaps.length > 0
        )) as SwapsResponse;
        let swap_embedded = body._embedded.swaps[0];
        swap_embedded.protocol.should.equal("rfc003");
        swap_embedded.status.should.equal("IN_PROGRESS");
        let swap_link = swap_embedded._links;
        swap_link.should.be.a("object");
        bob_swap_href = swap_link.self.href;
        bob_swap_href.should.be.a("string");
    });

    let bob_accept_href: string;

    it("[Bob] Can get the accept action after Alice sends the swap request", async function() {
        this.timeout(10000);
        let body: any = await bob.poll_comit_node_until(
            bob_swap_href,
            body => body._links.accept && body._links.decline
        );
        bob_accept_href = body._links.accept.href;
    });

    it("[Bob] Can execute the accept action", async () => {
        let bob_response: AcceptPayload = {
            beta_ledger_refund_identity: bob.wallet.eth().address(),
            alpha_ledger_redeem_identity: null,
        };

        let accept_res = await chai
            .request(bob.comit_node_url())
            .post(bob_accept_href)
            .send(bob_response);

        accept_res.should.have.status(200);
    });

    let alice_fund_action: Action;

    it("[Alice] Can get the fund action after Bob accepts", async function() {
        this.timeout(10000);
        let body = (await alice.poll_comit_node_until(
            alice_swap_href,
            body => body._links.fund
        )) as SwapResponse;
        let alice_fund_href = body._links.fund.href;
        let res = await chai
            .request(alice.comit_node_url())
            .get(alice_fund_href);
        res.should.have.status(200);
        alice_fund_action = res.body;
    });

    it("[Alice] Can execute the fund action", async function() {
        this.timeout(10000);
        alice_fund_action.payload.should.include.all.keys(
            "to",
            "amount",
            "network"
        );
        await alice.do(alice_fund_action);
        await chai.request(alice.comit_node_url()).get(alice_swap_href);
    });

    let bob_fund_action: any;

    it("[Bob] Can get the fund action after Alice funds", async function() {
        this.timeout(10000);
        let body: any = await bob.poll_comit_node_until(
            bob_swap_href,
            body => body._links.fund
        );
        let bob_fund_href = body._links.fund.href;
        let res = await chai.request(bob.comit_node_url()).get(bob_fund_href);
        res.should.have.status(200);
        bob_fund_action = res.body;
    });

    it("[Bob] Can execute the fund action", async () => {
        bob_fund_action.payload.should.include.all.keys(
            "data",
            "amount",
            "gas_limit",
            "network"
        );
        await bob.do(bob_fund_action);
    });

    let alice_redeem_action: Action;

    it("[Alice] Can get the redeem action after Bob funds", async function() {
        this.timeout(10000);
        let body = (await alice.poll_comit_node_until(
            alice_swap_href,
            body => body._links.redeem
        )) as SwapResponse;
        let alice_redeem_href = body._links.redeem.href;
        let res = await chai
            .request(alice.comit_node_url())
            .get(alice_redeem_href);
        res.should.have.status(200);
        alice_redeem_action = res.body;
    });

    let alice_eth_balance_before: BN;

    it("[Alice] Can execute the redeem action", async function() {
        alice_redeem_action.payload.should.include.all.keys(
            "contract_address",
            "data",
            "amount",
            "gas_limit",
            "network"
        );
        alice_eth_balance_before = await ethereum.ethBalance(
            alice_final_address
        );
        await alice.do(alice_redeem_action);
    });

    it("[Alice] Should have received the beta asset after the redeem", async function() {
        let alice_eth_balance_after = await ethereum.ethBalance(
            alice_final_address
        );

        let alice_eth_balance_expected = alice_eth_balance_before.add(
            beta_asset_quantity
        );

        alice_eth_balance_after
            .eq(alice_eth_balance_expected)
            .should.be.equal(true);
    });

    let bob_redeem_action: Action;

    it("[Bob] Can get the redeem action after Alice redeems", async function() {
        this.timeout(10000);
        let body = (await bob.poll_comit_node_until(
            bob_swap_href,
            body => body._links.redeem
        )) as SwapResponse;
        let bob_redeem_href = body._links.redeem.href;
        let res = await chai
            .request(bob.comit_node_url())
            .get(
                bob_redeem_href +
                    "?address=" +
                    bob_final_address +
                    "&fee_per_byte=20"
            );
        res.should.have.status(200);
        bob_redeem_action = res.body;
    });

    it("[Bob] Can execute the redeem action", async function() {
        bob_redeem_action.payload.should.include.all.keys("hex", "network");

        await bob.do(bob_redeem_action);
        await bitcoin.generate();
    });

    it("[Bob] Should have received the alpha asset after the redeem", async function() {
        this.timeout(10000);
        let body = (await bob.poll_comit_node_until(
            bob_swap_href,
            body => body.state.alpha_ledger.status === "Redeemed"
        )) as SwapResponse;
        let bob_redeem_txid = body.state.alpha_ledger.redeem_tx;

        let bob_satoshi_received = await bitcoin.getFirstUtxoValueTransferredTo(
            bob_redeem_txid,
            bob_final_address
        );
        const bob_satoshi_expected = alpha_asset_quantity - alpha_max_fee;

        bob_satoshi_received.should.be.at.least(bob_satoshi_expected);
    });
});

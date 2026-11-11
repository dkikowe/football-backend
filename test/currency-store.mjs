import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import pg from "pg";

// Every test run owns a temporary PostgreSQL database. No .env or deployed API.
const dbName = "football_currency_test_" + Date.now();
const adminUrl =
  process.env.TEST_ADMIN_DATABASE_URL ||
  `postgresql://${userInfo().username}@127.0.0.1:5432/postgres`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = "/" + dbName;
process.env.DATABASE_URL = dbUrl.toString();
process.env.NODE_ENV = "test";
process.env.GAME_SERVER_SECRET = "x".repeat(64);
process.env.APPLE_IAP_ENABLED = "false";
process.env.APPLE_IAP_FULFILLMENT_ENABLED = "false";
process.env.APPLE_IAP_ENVIRONMENT = "Production";
const { db, migrate } = await import("../dist/db.js");
const { exchangeCoins, fulfillVerifiedPurchase, applyVerifiedNotification } =
  await import("../dist/currency-store.js");
const {
  validateGemTransaction,
  appleStoreVerifier,
  fulfillApplePurchase,
  currencyCatalog,
} = await import("../dist/apple-store.js");
const { ApiController } = await import("../dist/api.js");
const { buy } = await import("../dist/economy.js");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const errorCode = (code) => (error) => error.getResponse?.().code === code;
let number = 123000000;
function purchase(playerId, overrides = {}) {
  return {
    environment: "Production",
    transactionId: String(++number),
    productId: "com.krutyev.arcadefootball.gems.80",
    accountToken: playerId,
    gems: 80,
    purchaseDate: Date.now() - 10000,
    signedDate: Date.now() - 5000,
    revoked: false,
    receiptHash: hash("fixture"),
    ...overrides,
  };
}
function notify(purchase, type, time) {
  return {
    environment: purchase.environment,
    notificationId: randomUUID(),
    type,
    signedDate: time,
    payloadHash: hash(type),
    purchase,
  };
}
async function player(gems = 0, linked = true) {
  const id = randomUUID();
  await db.query("INSERT INTO players(id,nickname) VALUES($1,'CurrencyTest')", [
    id,
  ]);
  await db.query(
    "INSERT INTO balances(player_id,coins,gems) VALUES($1,1000,$2)",
    [id, gems],
  );
  if (linked)
    await db.query(
      "INSERT INTO account_identities(provider,subject,player_id) VALUES('email',$1,$2)",
      [id + "@example.invalid", id],
    );
  return id;
}
async function wallet(id) {
  return (
    await db.query(
      "SELECT coins,gems,paid_gems_debt FROM balances WHERE player_id=$1",
      [id],
    )
  ).rows[0];
}

test(
  "currency store uses real SQL transactions and rejects unverified payment data",
  { timeout: 60000 },
  async (t) => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      await migrate();
      await t.test(
        "store starts closed and sandbox cannot use production configuration",
        () => {
          assert.equal(currencyCatalog().applePurchasesEnabled, false);
          assert.equal(currencyCatalog().gemPacks.length, 2);
          const child = spawnSync(
            process.execPath,
            ["-e", "require('./dist/apple-store.js')"],
            {
              cwd: new URL("..", import.meta.url),
              env: {
                ...process.env,
                NODE_ENV: "production",
                PUBLIC_API_URL: "https://example.invalid",
                APPLE_IAP_ENVIRONMENT: "Sandbox",
                APPLE_IAP_SANDBOX_ISOLATED: "true",
              },
              encoding: "utf8",
            },
          );
          assert.notEqual(child.status, 0);
          assert.match(child.stderr, /Sandbox IAP requires/);
        },
      );
      await t.test(
        "official Apple verifier rejects forged JWS and never grants a wallet",
        async () => {
          const id = await player();
          const forged = [
            Buffer.from('{"alg":"none"}').toString("base64url"),
            Buffer.from(
              JSON.stringify({
                appAccountToken: id,
                productId: "com.krutyev.arcadefootball.gems.80",
              }),
            ).toString("base64url"),
            "fake",
          ].join(".");
          await assert.rejects(
            appleStoreVerifier().verifyAndDecodeTransaction(forged),
          );
          await assert.rejects(
            fulfillApplePurchase(id, forged),
            errorCode("INVALID_APPLE_TRANSACTION"),
          );
          assert.equal((await wallet(id)).gems, 0);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM apple_purchase_transactions",
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "Apple transaction claims require bundle, environment, consumable, account token and exact quantity",
        () => {
          const valid = {
            bundleId: "com.krutyev.arcadefootball",
            environment: "Production",
            type: "Consumable",
            inAppOwnershipType: "PURCHASED",
            quantity: 1,
            productId: "com.krutyev.arcadefootball.gems.80",
            transactionId: "123456",
            appAccountToken: randomUUID(),
            purchaseDate: Date.now() - 10000,
            signedDate: Date.now() - 1000,
          };
          assert.equal(
            validateGemTransaction(valid, "verified-fixture").gems,
            80,
          );
          for (const bad of [
            { bundleId: "wrong" },
            { environment: "Sandbox" },
            { type: "Non-Consumable" },
            { quantity: 2 },
            { quantity: 0 },
            { appAccountToken: undefined },
            { productId: "evil" },
            { inAppOwnershipType: "FAMILY_SHARED" },
            { signedDate: Date.now() + 900000 },
            { transactionId: "not-an-apple-transaction" },
          ])
            assert.throws(
              () => validateGemTransaction({ ...valid, ...bad }, "fixture"),
              errorCode("INVALID_APPLE_TRANSACTION"),
            );
        },
      );
      await t.test(
        "strict authenticated API rejects client-supplied currency and player overrides",
        async () => {
          const id = await player(100);
          const controller = new ApiController(
            { auth: async () => id, me: async () => ({ id }) },
            {},
            {},
          );
          await assert.rejects(
            controller.exchange(
              {},
              { packId: "coins.1000", requestId: randomUUID(), gems: 0 },
            ),
            errorCode("VALIDATION_ERROR"),
          );
          await assert.rejects(
            controller.applePurchase(
              {},
              { signedTransaction: "a".repeat(100), playerId: randomUUID() },
            ),
            errorCode("VALIDATION_ERROR"),
          );
          await assert.rejects(
            controller.applePurchase(
              {},
              { signedTransaction: "a".repeat(100), gems: 99999 },
            ),
            errorCode("VALIDATION_ERROR"),
          );
          assert.equal((await wallet(id)).gems, 100);
        },
      );
      await t.test(
        "exchange concurrent retry spends and grants exactly once",
        async () => {
          const id = await player(100),
            requestId = randomUUID();
          await Promise.all(
            Array.from({ length: 8 }, () =>
              exchangeCoins(id, "coins.1000", requestId),
            ),
          );
          assert.deepEqual(await wallet(id), {
            coins: 2000,
            gems: 80,
            paid_gems_debt: 0,
          });
          await assert.rejects(
            exchangeCoins(id, "coins.5000", requestId),
            errorCode("REQUEST_REUSED"),
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM currency_exchanges WHERE player_id=$1",
                [id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "simultaneous distinct exchanges cannot overspend, insufficient funds is atomic",
        async () => {
          const id = await player(20);
          const results = await Promise.allSettled([
            exchangeCoins(id, "coins.1000", randomUUID()),
            exchangeCoins(id, "coins.1000", randomUUID()),
          ]);
          assert.equal(
            results.filter((x) => x.status === "fulfilled").length,
            1,
          );
          assert.deepEqual(await wallet(id), {
            coins: 2000,
            gems: 0,
            paid_gems_debt: 0,
          });
          await assert.rejects(
            exchangeCoins(id, "unknown", randomUUID()),
            errorCode("PACK_UNAVAILABLE"),
          );
        },
      );
      await t.test(
        "concurrent paid callbacks credit once and account switching cannot replay",
        async () => {
          const id = await player(),
            other = await player(),
            order = purchase(id);
          const results = await Promise.all(
            Array.from({ length: 8 }, () => fulfillVerifiedPurchase(id, order)),
          );
          assert.equal(results.filter((x) => !x.alreadyGranted).length, 1);
          assert.equal((await wallet(id)).gems, 80);
          await assert.rejects(
            fulfillVerifiedPurchase(other, order),
            errorCode("PURCHASE_ACCOUNT_MISMATCH"),
          );
          await assert.rejects(
            fulfillVerifiedPurchase(other, { ...order, accountToken: other }),
            errorCode("PURCHASE_CONFLICT"),
          );
          assert.equal((await wallet(other)).gems, 0);
          assert.equal(
            (await fulfillVerifiedPurchase(id, order, false)).alreadyGranted,
            true,
          );
        },
      );
      await t.test(
        "disabled delivery and unlinked guest never credit or consume transaction",
        async () => {
          const id = await player(),
            guest = await player(0, false),
            order = purchase(id);
          await assert.rejects(
            fulfillVerifiedPurchase(id, order, false),
            errorCode("PURCHASES_UNAVAILABLE"),
          );
          const guestOrder = purchase(guest);
          await assert.rejects(
            fulfillVerifiedPurchase(guest, guestOrder),
            errorCode("LINK_ACCOUNT_REQUIRED"),
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM apple_purchase_transactions WHERE transaction_id=ANY($1)",
                [[order.transactionId, guestOrder.transactionId]],
              )
            ).rows[0].n,
            0,
          );
          assert.equal((await wallet(guest)).gems, 0);
        },
      );
      await t.test(
        "missing wallet cannot acknowledge an undelivered paid purchase",
        async () => {
          const id = await player(),
            order = purchase(id);
          await db.query("DELETE FROM balances WHERE player_id=$1", [id]);
          await assert.rejects(
            fulfillVerifiedPurchase(id, order),
            errorCode("WALLET_UNAVAILABLE"),
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM apple_purchase_transactions WHERE transaction_id=$1",
                [order.transactionId],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "refund before delivery is retained and cannot be granted by an old valid receipt",
        async () => {
          const id = await player(),
            order = purchase(id),
            event = notify(order, "REFUND", Date.now());
          await applyVerifiedNotification(event);
          await assert.rejects(
            fulfillVerifiedPurchase(id, order),
            errorCode("PURCHASE_REVOKED"),
          );
          assert.equal((await wallet(id)).gems, 0);
          await applyVerifiedNotification(
            notify(order, "REFUND_REVERSED", event.signedDate + 1),
          );
          assert.equal(
            (await fulfillVerifiedPurchase(id, order)).alreadyGranted,
            false,
          );
          assert.equal((await wallet(id)).gems, 80);
        },
      );
      await t.test(
        "refund replay, late events and reversal adjust spent gems without negative balances",
        async () => {
          const id = await player(),
            order = purchase(id);
          await fulfillVerifiedPurchase(id, order);
          await exchangeCoins(id, "coins.1000", randomUUID());
          const refund = notify(order, "REFUND", Date.now());
          await Promise.all([
            applyVerifiedNotification(refund),
            applyVerifiedNotification(refund),
          ]);
          assert.deepEqual(await wallet(id), {
            coins: 2000,
            gems: 0,
            paid_gems_debt: 20,
          });
          await assert.rejects(
            exchangeCoins(id, "coins.1000", randomUUID()),
            errorCode("PURCHASE_ADJUSTMENT_PENDING"),
          );
          await assert.rejects(
            buy(id, "skin:galaxy"),
            errorCode("PURCHASE_ADJUSTMENT_PENDING"),
          );
          const reversed = notify(
            order,
            "REFUND_REVERSED",
            refund.signedDate + 10,
          );
          await applyVerifiedNotification(reversed);
          await applyVerifiedNotification(
            notify(order, "REFUND", refund.signedDate + 1),
          );
          await applyVerifiedNotification(reversed);
          assert.deepEqual(await wallet(id), {
            coins: 2000,
            gems: 60,
            paid_gems_debt: 0,
          });
          assert.equal(
            (await fulfillVerifiedPurchase(id, order)).alreadyGranted,
            true,
          );
        },
      );
      await t.test(
        "equal-time contradictory notifications resolve to refund in either delivery order",
        async () => {
          for (const reverseFirst of [true, false]) {
            const id = await player(),
              order = purchase(id),
              time = Date.now();
            await fulfillVerifiedPurchase(id, order);
            const refund = notify(order, "REFUND", time),
              reverse = notify(order, "REFUND_REVERSED", time);
            for (const event of reverseFirst
              ? [reverse, refund]
              : [refund, reverse])
              await applyVerifiedNotification(event);
            assert.equal((await wallet(id)).gems, 0);
            await assert.rejects(
              fulfillVerifiedPurchase(id, order),
              errorCode("PURCHASE_REVOKED"),
            );
          }
        },
      );
      await t.test(
        "revoked fulfillment records rejection durably and subsequent purchases settle debt",
        async () => {
          const id = await player(),
            order = purchase(id);
          await fulfillVerifiedPurchase(id, order);
          await exchangeCoins(id, "coins.1000", randomUUID());
          await assert.rejects(
            fulfillVerifiedPurchase(id, {
              ...order,
              revoked: true,
              signedDate: Date.now(),
            }),
            errorCode("PURCHASE_REVOKED"),
          );
          await fulfillVerifiedPurchase(id, purchase(id));
          assert.deepEqual(await wallet(id), {
            coins: 2000,
            gems: 60,
            paid_gems_debt: 0,
          });
          await assert.rejects(
            fulfillVerifiedPurchase(id, order),
            errorCode("PURCHASE_REVOKED"),
          );
        },
      );
      await t.test(
        "match-earned gems also settle spent-refund debt automatically",
        async () => {
          const id = await player(),
            order = purchase(id);
          await fulfillVerifiedPurchase(id, order);
          await exchangeCoins(id, "coins.1000", randomUUID());
          await applyVerifiedNotification(notify(order, "REFUND", Date.now()));
          await db.query("UPDATE balances SET gems=gems+5 WHERE player_id=$1", [
            id,
          ]);
          assert.deepEqual(await wallet(id), {
            coins: 2000,
            gems: 0,
            paid_gems_debt: 15,
          });
          await db.query(
            "UPDATE balances SET gems=gems+20 WHERE player_id=$1",
            [id],
          );
          assert.deepEqual(await wallet(id), {
            coins: 2000,
            gems: 5,
            paid_gems_debt: 0,
          });
        },
      );
      await t.test(
        "deleted profile leaves a replay tombstone without retaining player reference",
        async () => {
          const id = await player(),
            order = purchase(id);
          await fulfillVerifiedPurchase(id, order);
          await db.query("DELETE FROM balances WHERE player_id=$1", [id]);
          await db.query("DELETE FROM players WHERE id=$1", [id]);
          const row = (
            await db.query(
              "SELECT player_id,account_token_hash FROM apple_purchase_transactions WHERE transaction_id=$1",
              [order.transactionId],
            )
          ).rows[0];
          assert.equal(row.player_id, null);
          assert.equal(row.account_token_hash.trim(), hash(id));
          await applyVerifiedNotification(notify(order, "REFUND", Date.now()));
          const newId = await player();
          await assert.rejects(
            fulfillVerifiedPurchase(newId, order),
            errorCode("PURCHASE_ACCOUNT_MISMATCH"),
          );
          assert.equal((await wallet(newId)).gems, 0);
        },
      );
    } finally {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  },
);

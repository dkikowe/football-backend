import { PoolClient } from "pg";
import { db, transaction } from "./db";
import { fail, hash } from "./common";

export const gemPacks = Object.freeze([
  { productId: "com.krutyev.arcadefootball.gems.80", gems: 80 },
  { productId: "com.krutyev.arcadefootball.gems.180", gems: 180 },
]);
export const coinPacks = Object.freeze([
  { id: "coins.1000", coins: 1000, gems: 20 },
  { id: "coins.5000", coins: 5000, gems: 90 },
]);
const MAX_BALANCE = 2147483647;

async function lockPlayer(c: PoolClient, playerId: string, required: boolean) {
  const exists = !!(
    await c.query("SELECT id FROM players WHERE id=$1 FOR KEY SHARE", [
      playerId,
    ])
  ).rowCount;
  if (required && !exists) fail(401, "UNAUTHENTICATED", "Sign in again.");
  return exists;
}
export async function exchangeCoins(
  playerId: string,
  packId: string,
  requestId: string,
) {
  const pack = coinPacks.find((x) => x.id === packId);
  if (!pack) fail(404, "PACK_UNAVAILABLE", "Currency pack unavailable.");
  await transaction(async (c) => {
    await lockPlayer(c, playerId, true);
    const balance = (
      await c.query("SELECT * FROM balances WHERE player_id=$1 FOR UPDATE", [
        playerId,
      ])
    ).rows[0];
    if (!balance) fail(401, "UNAUTHENTICATED", "Sign in again.");
    const previous = (
      await c.query(
        "SELECT pack_id FROM currency_exchanges WHERE player_id=$1 AND request_id=$2",
        [playerId, requestId],
      )
    ).rows[0];
    if (previous) {
      if (previous.pack_id !== pack.id)
        fail(
          409,
          "REQUEST_REUSED",
          "This exchange request already belongs to another pack.",
        );
      return;
    }
    if (balance.paid_gems_debt > 0)
      fail(
        409,
        "PURCHASE_ADJUSTMENT_PENDING",
        "A refunded purchase requires a wallet adjustment. Contact support.",
      );
    if (balance.gems < pack.gems)
      fail(409, "INSUFFICIENT_FUNDS", "Not enough gems.");
    if (balance.coins > MAX_BALANCE - pack.coins)
      fail(409, "WALLET_LIMIT", "Your coin wallet is full.");
    await c.query(
      "UPDATE balances SET gems=gems-$2,coins=coins+$3 WHERE player_id=$1",
      [playerId, pack.gems, pack.coins],
    );
    await c.query(
      "INSERT INTO currency_exchanges(player_id,request_id,pack_id,gems_spent,coins_granted) VALUES($1,$2,$3,$4,$5)",
      [playerId, requestId, pack.id, pack.gems, pack.coins],
    );
  });
}

// Only apple-store.ts supplies this type after Apple's cryptographic verification.
export interface VerifiedGemPurchase {
  environment: "Production" | "Sandbox";
  transactionId: string;
  productId: string;
  accountToken: string;
  gems: number;
  purchaseDate: number;
  signedDate: number;
  revoked: boolean;
  receiptHash: string;
}
async function purchaseRow(
  c: PoolClient,
  purchase: VerifiedGemPurchase,
  requirePlayer: boolean,
) {
  // The same transaction has one lock across fulfillment and signed notifications.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `apple:${purchase.environment}:${purchase.transactionId}`,
  ]);
  const exists = await lockPlayer(c, purchase.accountToken, requirePlayer);
  await c.query(
    `INSERT INTO apple_purchase_transactions(environment,transaction_id,product_id,account_token_hash,player_id,gems,purchase_at,receipt_hash)
    VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::double precision/1000),$8) ON CONFLICT DO NOTHING`,
    [
      purchase.environment,
      purchase.transactionId,
      purchase.productId,
      hash(purchase.accountToken),
      exists ? purchase.accountToken : null,
      purchase.gems,
      purchase.purchaseDate,
      purchase.receiptHash,
    ],
  );
  const row = (
    await c.query(
      "SELECT * FROM apple_purchase_transactions WHERE environment=$1 AND transaction_id=$2 FOR UPDATE",
      [purchase.environment, purchase.transactionId],
    )
  ).rows[0];
  if (
    row.account_token_hash.trim() !== hash(purchase.accountToken) ||
    row.product_id !== purchase.productId ||
    row.gems !== purchase.gems
  )
    fail(
      409,
      "PURCHASE_CONFLICT",
      "This purchase is already associated with another account or product.",
    );
  return row;
}
async function adjustGems(
  c: PoolClient,
  playerId: string | null,
  delta: number,
) {
  if (!playerId) return;
  const balance = (
    await c.query(
      "SELECT gems,paid_gems_debt FROM balances WHERE player_id=$1 FOR UPDATE",
      [playerId],
    )
  ).rows[0];
  if (!balance)
    fail(
      503,
      "WALLET_UNAVAILABLE",
      "Your wallet is temporarily unavailable. Please retry.",
    );
  let gems = balance.gems,
    debt = balance.paid_gems_debt;
  if (delta > 0) {
    const paidDebt = Math.min(debt, delta);
    debt -= paidDebt;
    gems += delta - paidDebt;
  } else {
    const reclaimed = Math.min(gems, -delta);
    gems -= reclaimed;
    debt += -delta - reclaimed;
  }
  if (gems > MAX_BALANCE || debt > MAX_BALANCE)
    fail(409, "WALLET_LIMIT", "Your wallet needs a support adjustment.");
  await c.query(
    "UPDATE balances SET gems=$2,paid_gems_debt=$3 WHERE player_id=$1",
    [playerId, gems, debt],
  );
}
async function setRevocation(
  c: PoolClient,
  row: any,
  purchase: VerifiedGemPurchase,
  revoked: boolean,
  signedDate: number,
) {
  const previousDate = Number(row.state_signed_at);
  // Conflicting events with equal timestamps resolve to revocation, regardless of delivery order.
  if (
    signedDate < previousDate ||
    (signedDate === previousDate && (!revoked || row.revoked))
  )
    return;
  if (Boolean(row.revoked) !== revoked && row.granted_at)
    await adjustGems(c, row.player_id, revoked ? -row.gems : row.gems);
  await c.query(
    "UPDATE apple_purchase_transactions SET revoked=$3,state_signed_at=$4,updated_at=now() WHERE environment=$1 AND transaction_id=$2",
    [purchase.environment, purchase.transactionId, revoked, signedDate],
  );
  row.revoked = revoked;
  row.state_signed_at = signedDate;
}
export async function fulfillVerifiedPurchase(
  playerId: string,
  purchase: VerifiedGemPurchase,
  allowNewGrant = true,
) {
  if (purchase.accountToken !== playerId.toLowerCase())
    fail(
      403,
      "PURCHASE_ACCOUNT_MISMATCH",
      "Sign in to the account that made this purchase.",
    );
  const result = await transaction(async (c) => {
    const row = await purchaseRow(c, purchase, true);
    // Record revocation durably, even when returning a rejected purchase below.
    if (purchase.revoked)
      await setRevocation(c, row, purchase, true, purchase.signedDate);
    if (row.revoked) return { revoked: true, alreadyGranted: !!row.granted_at };
    if (row.granted_at) return { revoked: false, alreadyGranted: true };
    if (!allowNewGrant)
      fail(
        503,
        "PURCHASES_UNAVAILABLE",
        "Purchase delivery is temporarily unavailable. Please retry.",
      );
    if (
      !(
        await c.query("SELECT 1 FROM account_identities WHERE player_id=$1", [
          playerId,
        ])
      ).rowCount
    )
      fail(
        403,
        "LINK_ACCOUNT_REQUIRED",
        "Link Apple or email before buying gems so your purchases can be recovered.",
      );
    await adjustGems(c, playerId, purchase.gems);
    await c.query(
      "UPDATE apple_purchase_transactions SET granted_at=now(),updated_at=now() WHERE environment=$1 AND transaction_id=$2",
      [purchase.environment, purchase.transactionId],
    );
    return { revoked: false, alreadyGranted: false };
  });
  if (result.revoked)
    fail(
      409,
      "PURCHASE_REVOKED",
      "Apple has refunded or revoked this purchase.",
    );
  return {
    transactionId: purchase.transactionId,
    productId: purchase.productId,
    gems: purchase.gems,
    alreadyGranted: result.alreadyGranted,
  };
}
export interface VerifiedStoreNotification {
  environment: "Production" | "Sandbox";
  notificationId: string;
  type: string;
  signedDate: number;
  payloadHash: string;
  purchase?: VerifiedGemPurchase;
}
export async function applyVerifiedNotification(
  event: VerifiedStoreNotification,
) {
  await transaction(async (c) => {
    const inserted = await c.query(
      "INSERT INTO apple_store_notifications(environment,notification_id,notification_type,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING notification_id",
      [event.environment, event.notificationId, event.type, event.payloadHash],
    );
    if (!inserted.rowCount) return;
    if (!event.purchase) return;
    const row = await purchaseRow(c, event.purchase, false);
    if (event.type === "REFUND" || event.type === "REVOKE")
      await setRevocation(c, row, event.purchase, true, event.signedDate);
    else if (event.type === "REFUND_REVERSED")
      await setRevocation(c, row, event.purchase, false, event.signedDate);
  });
  return { ok: true };
}

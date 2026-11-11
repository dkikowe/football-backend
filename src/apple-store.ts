import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Environment,
  Type,
  InAppOwnershipType,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import { config } from "./config";
import { fail, hash } from "./common";
import {
  applyVerifiedNotification,
  fulfillVerifiedPurchase,
  gemPacks,
  coinPacks,
  VerifiedGemPurchase,
  VerifiedStoreNotification,
} from "./currency-store";

const settings = z
  .object({
    APPLE_IAP_ENABLED: z.enum(["true", "false"]).default("false"),
    APPLE_IAP_FULFILLMENT_ENABLED: z.enum(["true", "false"]).default("false"),
    APPLE_IAP_ENVIRONMENT: z
      .enum(["Production", "Sandbox"])
      .default("Production"),
    APPLE_IAP_SANDBOX_ISOLATED: z.enum(["true", "false"]).default("false"),
  })
  .parse(process.env);
const bundleId = "com.krutyev.arcadefootball",
  appAppleId = 6821407520;
if (
  settings.APPLE_IAP_ENVIRONMENT === "Sandbox" &&
  (config.NODE_ENV === "production" ||
    settings.APPLE_IAP_SANDBOX_ISOLATED !== "true")
)
  throw new Error(
    "Sandbox IAP requires an explicitly isolated nonproduction database and deployment.",
  );
if (
  settings.APPLE_IAP_ENABLED === "true" &&
  settings.APPLE_IAP_FULFILLMENT_ENABLED !== "true"
)
  throw new Error("New Apple purchases require fulfillment to be enabled.");
let verifier: SignedDataVerifier | undefined;
export function appleStoreVerifier() {
  if (!verifier) {
    const roots = [
      "AppleIncRootCertificate.cer",
      "AppleRootCA-G2.cer",
      "AppleRootCA-G3.cer",
    ].map((name) =>
      readFileSync(join(__dirname, "../certificates/apple", name)),
    );
    verifier = new SignedDataVerifier(
      roots,
      true,
      settings.APPLE_IAP_ENVIRONMENT as Environment,
      bundleId,
      appAppleId,
    );
  }
  return verifier;
}
export function currencyCatalog() {
  return {
    applePurchasesEnabled: settings.APPLE_IAP_ENABLED === "true",
    environment: settings.APPLE_IAP_ENVIRONMENT,
    requireLinkedAccount: true,
    gemPacks,
    coinPacks,
  };
}
function verificationError(error: unknown): never {
  if (
    error instanceof VerificationException &&
    error.status !== VerificationStatus.RETRYABLE_VERIFICATION_FAILURE
  )
    fail(
      400,
      "INVALID_APPLE_TRANSACTION",
      "Apple could not verify this purchase.",
    );
  fail(
    503,
    "APPLE_VERIFICATION_UNAVAILABLE",
    "Purchase verification is temporarily unavailable. Please retry.",
  );
}
export function validateGemTransaction(
  decoded: JWSTransactionDecodedPayload,
  receipt: string,
  environment: string = settings.APPLE_IAP_ENVIRONMENT,
): VerifiedGemPurchase {
  const pack = gemPacks.find((x) => x.productId === decoded.productId);
  if (
    !pack ||
    decoded.bundleId !== bundleId ||
    decoded.environment !== environment ||
    !["Production", "Sandbox"].includes(environment) ||
    decoded.type !== Type.CONSUMABLE ||
    decoded.inAppOwnershipType !== InAppOwnershipType.PURCHASED ||
    decoded.quantity !== 1 ||
    !decoded.transactionId ||
    !/^\d{1,80}$/.test(decoded.transactionId) ||
    !decoded.appAccountToken ||
    !z.uuid().safeParse(decoded.appAccountToken).success ||
    !Number.isSafeInteger(decoded.purchaseDate) ||
    decoded.purchaseDate! <= 0 ||
    decoded.purchaseDate! > Date.now() + 300000 ||
    !Number.isSafeInteger(decoded.signedDate) ||
    decoded.signedDate! < decoded.purchaseDate! ||
    decoded.signedDate! > Date.now() + 300000
  )
    fail(
      400,
      "INVALID_APPLE_TRANSACTION",
      "The purchase does not match this app, account, environment or currency pack.",
    );
  return {
    environment: environment as "Production" | "Sandbox",
    transactionId: decoded.transactionId,
    productId: pack.productId,
    accountToken: decoded.appAccountToken.toLowerCase(),
    gems: pack.gems,
    purchaseDate: decoded.purchaseDate!,
    signedDate: decoded.signedDate!,
    revoked:
      decoded.revocationDate !== undefined ||
      decoded.revocationReason !== undefined,
    receiptHash: hash(receipt),
  };
}
export async function fulfillApplePurchase(
  playerId: string,
  signedTransaction: string,
) {
  let decoded: JWSTransactionDecodedPayload;
  try {
    decoded =
      await appleStoreVerifier().verifyAndDecodeTransaction(signedTransaction);
  } catch (error) {
    return verificationError(error);
  }
  return fulfillVerifiedPurchase(
    playerId,
    validateGemTransaction(decoded, signedTransaction),
    settings.APPLE_IAP_FULFILLMENT_ENABLED === "true",
  );
}
export async function appleStoreNotification(signedPayload: string) {
  let event: VerifiedStoreNotification;
  try {
    const decoded =
      await appleStoreVerifier().verifyAndDecodeNotification(signedPayload);
    if (
      !z.uuid().safeParse(decoded.notificationUUID).success ||
      !decoded.notificationType ||
      !Number.isSafeInteger(decoded.signedDate)
    )
      fail(
        400,
        "INVALID_APPLE_NOTIFICATION",
        "Incomplete signed notification.",
      );
    event = {
      environment: settings.APPLE_IAP_ENVIRONMENT,
      notificationId: decoded.notificationUUID!,
      type: decoded.notificationType,
      signedDate: decoded.signedDate!,
      payloadHash: hash(signedPayload),
    };
    if (["REFUND", "REVOKE", "REFUND_REVERSED"].includes(event.type)) {
      if (!decoded.data?.signedTransactionInfo)
        fail(400, "INVALID_APPLE_NOTIFICATION", "Signed transaction required.");
      const transaction = await appleStoreVerifier().verifyAndDecodeTransaction(
        decoded.data.signedTransactionInfo,
      );
      event.purchase = validateGemTransaction(
        transaction,
        decoded.data.signedTransactionInfo,
      );
    }
  } catch (error) {
    return verificationError(error);
  }
  return applyVerifiedNotification(event);
}

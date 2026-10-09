import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  Module,
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Request, Response, NextFunction, json } from "express";
import { ApiController } from "./api";
import { AuthService } from "./auth";
import { SocialService } from "./social";
import { MatchesService } from "./matches";
import { config } from "./config";
import { db, redis, key, migrate } from "./db";
import { hash } from "./common";
import { clientIpResolver } from "./client-ip";
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const value = error.getResponse();
      response.status(error.getStatus()).json(
        typeof value === "object" && "code" in value
          ? value
          : {
              statusCode: error.getStatus(),
              code: error.getStatus() === 404 ? "NOT_FOUND" : "REQUEST_FAILED",
              message: typeof value === "string" ? value : "Request failed.",
            },
      );
    } else {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          error: error instanceof Error ? error.name : "unknown",
        }) + "\n",
      );
      response.status(500).json({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "Request could not be completed.",
      });
    }
  }
}
@Module({
  controllers: [ApiController],
  providers: [AuthService, SocialService, MatchesService],
})
class AppModule {}
async function main() {
  await redis.connect();
  await migrate();
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn"],
    bodyParser: false,
  });
  app.use(json({ limit: "32kb" }));
  const resolveClientIp = clientIpResolver(config.TRUSTED_PROXY_CIDRS);
  let reportedUntrustedProxy = false;
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.path === "/health") {
      next();
      return;
    }
    try {
      const ip = resolveClientIp(req);
      if (
        !reportedUntrustedProxy &&
        process.env.RAILWAY_DEPLOYMENT_ID &&
        req.headers["x-railway-edge"] &&
        req.headers["x-real-ip"] &&
        ip === req.socket.remoteAddress
      ) {
        // A socket address is configuration evidence; never log tokens or headers.
        reportedUntrustedProxy = true;
        process.stdout.write(
          JSON.stringify({
            level: "warn",
            event: "untrusted_proxy_peer",
            peer: req.socket.remoteAddress,
          }) + "\n",
        );
      }
      const bucket = Math.floor(Date.now() / 60000);
      const limit = req.path.startsWith("/internal/")
        ? 1200
        : req.path === "/v1/auth/guest"
          ? 30
          : config.API_RATE_LIMIT;
      const identity =
        req.path.startsWith("/v1/") &&
        !req.path.startsWith("/v1/auth/") &&
        req.headers.authorization?.startsWith("Bearer ")
          ? hash(req.headers.authorization)
          : hash(ip);
      const bucketKey = key(
        `rate:${identity}:${req.path === "/v1/auth/guest" ? "guest" : req.path.startsWith("/internal/") ? "server" : "api"}:${bucket}`,
      );
      const count = await redis.incr(bucketKey);
      if (count === 1) await redis.expire(bucketKey, 65);
      // Changing an invalid bearer string must not create unlimited rate-limit buckets.
      const ipKey = key(`rate-ip:${hash(ip)}:${bucket}`);
      const ipCount = await redis.incr(ipKey);
      if (ipCount === 1) await redis.expire(ipKey, 65);
      if (count > limit || ipCount > Math.max(1200, config.API_RATE_LIMIT)) {
        res.status(429).json({
          statusCode: 429,
          code: "RATE_LIMITED",
          message: "Too many requests. Try again shortly.",
        });
        return;
      }
      next();
    } catch {
      res.status(503).json({
        statusCode: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "Session service unavailable.",
      });
    }
  });
  app.useGlobalFilters(new Errors());
  await app.listen(config.PORT, "0.0.0.0");
  process.stdout.write(
    JSON.stringify({ level: "info", event: "api_ready", port: config.PORT }) +
      "\n",
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await redis.quit();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      level: "error",
      event: "startup_failed",
      error: error instanceof Error ? error.name : "unknown",
    }) + "\n",
  );
  process.exit(1);
});

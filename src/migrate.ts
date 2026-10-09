import { db, migrate } from "./db";
migrate()
  .then(() => {
    console.log("Migrations applied");
    return db.end();
  })
  .catch(() => {
    console.error("Migration failed");
    process.exitCode = 1;
    return db.end();
  });

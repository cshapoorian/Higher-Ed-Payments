import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { corsOriginCheck } from "./lib/corsOrigin.js";
import { errorHandler } from "./lib/asyncHandler.js";
import { healthRouter } from "./routes/health.js";
import { catalogRouter } from "./routes/catalog.js";
import { cartRouter } from "./routes/cart.js";
import { customersRouter } from "./routes/customers.js";
import { ordersRouter } from "./routes/orders.js";
import { installmentsRouter } from "./routes/installments.js";
import { webhooksRouter } from "./routes/webhooks.js";

const app = express();

app.use(cors({ origin: env.corsOrigin === "*" ? true : corsOriginCheck(env.corsOrigin) }));

// Webhook route needs the raw body for signature verification, so it gets
// express.raw() scoped to just that path — everything else uses express.json().
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRouter);

app.use(express.json());
app.use("/api", healthRouter);
app.use("/api", catalogRouter);
app.use("/api", cartRouter);
app.use("/api", customersRouter);
app.use("/api", ordersRouter);
app.use("/api", installmentsRouter);

// Must be registered last — Express recognizes an error handler by its
// 4-arg signature and only invokes it when a route calls next(err), which
// every route does via asyncHandler. Without this, an async route's
// rejection is an unhandled rejection that crashes the whole process.
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`storefront API listening on :${env.port}`);
});

import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { healthRouter } from "./routes/health.js";
import { catalogRouter } from "./routes/catalog.js";
import { cartRouter } from "./routes/cart.js";
import { ordersRouter } from "./routes/orders.js";
import { webhooksRouter } from "./routes/webhooks.js";

const app = express();

app.use(
  cors({
    origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(",").map((o) => o.trim()),
  }),
);

// Webhook route needs the raw body for signature verification, so it gets
// express.raw() scoped to just that path — everything else uses express.json().
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhooksRouter);

app.use(express.json());
app.use("/api", healthRouter);
app.use("/api", catalogRouter);
app.use("/api", cartRouter);
app.use("/api", ordersRouter);

app.listen(env.port, () => {
  console.log(`storefront API listening on :${env.port}`);
});

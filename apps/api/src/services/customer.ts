import { db } from "../db.js";
import { createCustomer } from "./hyperswitch.js";

/**
 * One tokenized Hyperswitch Customer per student, reused every term — see
 * architecture §4. Idempotent in both directions: against our own DB, and
 * against Hyperswitch, which is the case that actually bites.
 *
 * Our column going out of sync with Hyperswitch is normal, not exotic — a
 * re-seed, a restored dev.db, or a crash between the create call and the
 * update below all leave the customer live at Hyperswitch while our column
 * reads null. Retrying the create then fails with IR_12 ("Customer with the
 * given `customer_id` already exists"), and because that surfaced as an
 * unhandled 500 from POST /orders/payment-intent, *every* payment method
 * became unselectable for that student with no way to recover short of
 * editing the database. The customer id we send is the student id, so an
 * IR_12 means the customer we wanted already exists: adopt it.
 */
export async function ensureHyperswitchCustomer(studentId: string): Promise<string> {
  const student = await db.student.findUniqueOrThrow({ where: { id: studentId } });
  if (student.hyperswitchCustomerId) return student.hyperswitchCustomerId;

  let customerId: string;
  try {
    const customer = await createCustomer({
      studentId: student.id,
      name: student.name,
      email: student.email,
    });
    customerId = customer.customer_id;
  } catch (err) {
    if (!isCustomerAlreadyExists(err)) throw err;
    customerId = student.id;
  }

  await db.student.update({
    where: { id: student.id },
    data: { hyperswitchCustomerId: customerId },
  });

  return customerId;
}

/** Hyperswitch's "this customer_id is taken" error — safe to treat as success. */
function isCustomerAlreadyExists(err: unknown): boolean {
  return err instanceof Error && err.message.includes("IR_12");
}

import { db } from "../db.js";
import { createCustomer } from "./hyperswitch.js";

/**
 * One tokenized Hyperswitch Customer per student, reused every term — see
 * architecture §4. Idempotent: returns the existing customer_id if this
 * student already has one instead of creating a duplicate.
 */
export async function ensureHyperswitchCustomer(studentId: string): Promise<string> {
  const student = await db.student.findUniqueOrThrow({ where: { id: studentId } });
  if (student.hyperswitchCustomerId) return student.hyperswitchCustomerId;

  const customer = await createCustomer({
    studentId: student.id,
    name: student.name,
    email: student.email,
  });

  await db.student.update({
    where: { id: student.id },
    data: { hyperswitchCustomerId: customer.customer_id },
  });

  return customer.customer_id;
}

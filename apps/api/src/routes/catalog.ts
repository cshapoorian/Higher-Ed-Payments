import { Router } from "express";
import { db } from "../db.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const catalogRouter = Router();

// Backs the Courses step. Flat add/remove list — no conflict/prerequisite
// checking by design. See architecture §3.
catalogRouter.get(
  "/course-sections",
  asyncHandler(async (_req, res) => {
    const sections = await db.courseSection.findMany();
    res.json({ courseSections: sections });
  }),
);

// No auth in this prototype — returns the single seeded student/term so the
// storefront has something to price an invoice against. See "Deferred" §3
// for the real authorized-payer / login flow this stands in for.
catalogRouter.get(
  "/me",
  asyncHandler(async (_req, res) => {
    const [student] = await db.student.findMany({ take: 1 });
    const [term] = await db.term.findMany({ take: 1 });
    res.json({ student, term });
  }),
);

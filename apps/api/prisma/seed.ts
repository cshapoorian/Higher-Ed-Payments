import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Render's free plan has no persistent disk, so the SQLite file is wiped
  // on every idle→wake cycle — this runs on every boot (see render.yaml's
  // startCommand), so it must no-op once data already exists rather than
  // erroring on the next warm restart.
  const alreadySeeded = await prisma.courseSection.count();
  if (alreadySeeded > 0) {
    console.log("Database already has data, skipping seed.");
    return;
  }

  const term = await prisma.term.create({
    data: { label: "Fall 2026", dueDate: new Date("2026-09-15") },
  });

  const student = await prisma.student.create({
    data: { name: "Jordan Rivera", email: "jordan.rivera@example.edu" },
  });

  await prisma.courseSection.createMany({
    data: [
      { code: "CS 101", title: "Intro to Computer Science", credits: 3, tuitionCents: 180_000 },
      { code: "CS 201", title: "Data Structures", credits: 4, tuitionCents: 240_000 },
      { code: "MATH 150", title: "Calculus I", credits: 4, tuitionCents: 240_000 },
      { code: "ENG 110", title: "Academic Writing", credits: 3, tuitionCents: 180_000 },
    ],
  });

  console.log("Seeded term:", term.id, "student:", student.id);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

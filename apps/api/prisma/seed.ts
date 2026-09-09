import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
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

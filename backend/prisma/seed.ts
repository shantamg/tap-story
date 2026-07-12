import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // NOTE: audioUrl stores an S3 *key* (the routes pass it to generateDownloadUrl),
  // not a full URL. These placeholder keys have no backing S3 object, so the
  // seeded nodes exist for DB-shape testing only and will not play back.
  const rootNode = await prisma.audioNode.create({
    data: {
      audioUrl: 'audio/00000000-0000-4000-8000-000000000001-root.wav',
      durationMs: 30_000,
      startTimeMs: 0,
    },
  });

  console.log('Created root node:', rootNode);

  // Create a child node
  const childNode = await prisma.audioNode.create({
    data: {
      audioUrl: 'audio/00000000-0000-4000-8000-000000000002-child.wav',
      parentId: rootNode.id,
      durationMs: 45_000,
      startTimeMs: 0,
    },
  });

  console.log('Created child node:', childNode);

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

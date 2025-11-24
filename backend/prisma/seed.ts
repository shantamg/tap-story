import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create a root audio node for testing
  const rootNode = await prisma.audioNode.create({
    data: {
      audioUrl: 'https://example.com/audio/root.mp3',
      duration: 30,
    },
  });

  console.log('Created root node:', rootNode);

  // Create a child node
  const childNode = await prisma.audioNode.create({
    data: {
      audioUrl: 'https://example.com/audio/child.mp3',
      parentId: rootNode.id,
      duration: 45,
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

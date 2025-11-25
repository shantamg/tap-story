import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { generateUploadUrl, generateDownloadUrl } from '../services/s3Service';

const router = Router();
const prisma = new PrismaClient();

// Get presigned URL for upload
router.post('/upload-url', async (req: Request, res: Response) => {
  try {
    const { filename, contentType } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Filename required' });
    }

    const result = await generateUploadUrl(filename, contentType);
    res.json(result);
  } catch (error) {
    console.error('Upload URL generation error:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// Save audio metadata after successful upload
router.post('/save', async (req: Request, res: Response) => {
  try {
    const { key, duration, parentId } = req.body;

    if (!key || duration === undefined) {
      return res.status(400).json({ error: 'Key and duration required' });
    }

    const audioNode = await prisma.audioNode.create({
      data: {
        audioUrl: key,
        duration,
        parentId: parentId || null,
      },
    });

    // Return with presigned download URL
    const downloadUrl = await generateDownloadUrl(audioNode.audioUrl);

    res.status(201).json({
      ...audioNode,
      audioUrl: downloadUrl,
    });
  } catch (error) {
    console.error('Save audio error:', error);
    res.status(500).json({ error: 'Failed to save audio' });
  }
});

// List all audio chains (leaf nodes - nodes with no children) with segment data for preview
router.get('/chains', async (req: Request, res: Response) => {
  try {
    // Find all leaf nodes (nodes that are not a parent of any other node)
    const leafNodes = await prisma.audioNode.findMany({
      where: {
        children: {
          none: {},
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // For each leaf, get the full chain with segments
    const chains = await Promise.all(
      leafNodes.map(async (leaf) => {
        // Traverse to get all ancestors
        const segments: Array<{ id: string; duration: number; parentId: string | null }> = [];
        let currentId: string | null = leaf.id;

        while (currentId) {
          const node: { id: string; duration: number; parentId: string | null } | null = await prisma.audioNode.findUnique({
            where: { id: currentId },
            select: { id: true, duration: true, parentId: true },
          });
          if (!node) break;
          segments.unshift(node); // Add to front to maintain order (oldest first)
          currentId = node.parentId;
        }

        // Calculate start times for each segment based on duet rules (iterative)
        const segmentsWithStartTimes: Array<{ id: string; duration: number; parentId: string | null; startTime: number }> = [];
        for (let index = 0; index < segments.length; index++) {
          const seg = segments[index];
          let startTime = 0;

          if (index === 0) {
            startTime = 0;
          } else if (index === 1) {
            startTime = 0; // Second recording duets with first
          } else {
            // Find earliest end time among previous segments
            const endTimes = segmentsWithStartTimes.map(s => s.startTime + s.duration);
            const sortedEndTimes = [...endTimes].sort((a, b) => a - b);
            startTime = sortedEndTimes[index - 2]; // Second-to-last end time
          }

          segmentsWithStartTimes.push({ ...seg, startTime });
        }

        // Calculate total timeline duration
        const totalDuration = segmentsWithStartTimes.length > 0
          ? Math.max(...segmentsWithStartTimes.map(s => s.startTime + s.duration))
          : 0;

        return {
          id: leaf.id,
          chainLength: segments.length,
          totalDuration,
          createdAt: leaf.createdAt,
          segments: segmentsWithStartTimes,
        };
      })
    );

    res.json({ chains });
  } catch (error) {
    console.error('List chains error:', error);
    res.status(500).json({ error: 'Failed to list chains' });
  }
});

// Get audio tree for playback (ancestor chain)
router.get('/tree/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get the node and all its ancestors by traversing parent links
    interface AncestorNode {
      id: string;
      audioUrl: string;
      parentId: string | null;
      duration: number;
      createdAt: Date;
      updatedAt: Date;
    }

    const ancestors: AncestorNode[] = [];
    let currentId: string | null = id;

    while (currentId) {
      const foundNode: AncestorNode | null = await prisma.audioNode.findUnique({
        where: { id: currentId },
      });

      if (!foundNode) {
        if (ancestors.length === 0) {
          return res.status(404).json({ error: 'Audio node not found' });
        }
        break;
      }

      const downloadUrl = await generateDownloadUrl(foundNode.audioUrl);
      ancestors.unshift({
        ...foundNode,
        audioUrl: downloadUrl,
      });

      currentId = foundNode.parentId;
    }

    res.json({ ancestors });
  } catch (error) {
    console.error('Get tree error:', error);
    res.status(500).json({ error: 'Failed to get audio tree' });
  }
});

export default router;

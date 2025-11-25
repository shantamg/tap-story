import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { generateUploadUrl, generateDownloadUrl, deleteAudioFile } from '../services/s3Service';
import { measureLatencyMsForKeys } from '../utils/latencyCalibration';

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

// Calibrate latency between two audio nodes (reference and test)
router.post('/calibrate', async (req: Request, res: Response) => {
  try {
    const { referenceNodeId, testNodeId } = req.body as {
      referenceNodeId?: string;
      testNodeId?: string;
    };

    if (!referenceNodeId || !testNodeId) {
      return res.status(400).json({ error: 'referenceNodeId and testNodeId are required' });
    }

    const referenceNode = await prisma.audioNode.findUnique({
      where: { id: referenceNodeId },
      select: { id: true, audioUrl: true },
    });

    const testNode = await prisma.audioNode.findUnique({
      where: { id: testNodeId },
      select: { id: true, audioUrl: true },
    });

    if (!referenceNode || !testNode) {
      return res.status(404).json({ error: 'Reference or test node not found' });
    }

    const offsetMs = await measureLatencyMsForKeys(referenceNode.audioUrl, testNode.audioUrl);

    res.json({
      referenceNodeId,
      testNodeId,
      offsetMs,
    });
  } catch (error) {
    console.error('Calibrate latency error:', error);
    res.status(500).json({ error: 'Failed to calibrate latency' });
  }
});

// Delete a chain (all nodes in the tree) and their S3 files
router.delete('/chain/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get all nodes in the chain (tree) by traversing from leaf to root
    const nodesToDelete: Array<{ id: string; audioUrl: string }> = [];
    let currentId: string | null = id;

    while (currentId) {
      const node: { id: string; audioUrl: string; parentId: string | null } | null = await prisma.audioNode.findUnique({
        where: { id: currentId },
        select: { id: true, audioUrl: true, parentId: true },
      });

      if (!node) {
        break;
      }

      nodesToDelete.push({ id: node.id, audioUrl: node.audioUrl });
      currentId = node.parentId;
    }

    // Delete from S3 first (before database deletion)
    for (const node of nodesToDelete) {
      try {
        await deleteAudioFile(node.audioUrl);
      } catch (s3Error) {
        console.error(`Failed to delete S3 file ${node.audioUrl}:`, s3Error);
        // Continue even if S3 delete fails
      }
    }

    // Delete all nodes from database
    // Delete from leaf to root to avoid foreign key constraint issues
    // (though with ON DELETE SET NULL, order shouldn't matter, but being safe)
    for (const node of nodesToDelete) {
      try {
        await prisma.audioNode.delete({
          where: { id: node.id },
        });
      } catch (dbError) {
        console.error(`Failed to delete database node ${node.id}:`, dbError);
        // Continue even if one delete fails
      }
    }

    res.json({ 
      success: true, 
      deletedNodes: nodesToDelete.length,
      nodeIds: nodesToDelete.map(n => n.id)
    });
  } catch (error) {
    console.error('Delete chain error:', error);
    res.status(500).json({ error: 'Failed to delete chain' });
  }
});

export default router;

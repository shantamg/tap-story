import { DuetPlayer } from '../duetPlayer';

describe('DuetPlayer', () => {
  let player: DuetPlayer;

  beforeEach(() => {
    player = new DuetPlayer();
  });

  it('should load audio chain with overlapping segments', async () => {
    // A: 0-10, B: 0-15 (overlapping duet)
    const mockChain = [
      { id: '1', audioUrl: 'http://test.com/1.webm', duration: 10, startTime: 0 },
      { id: '2', audioUrl: 'http://test.com/2.webm', duration: 15, startTime: 0 },
    ];

    await player.loadChain(mockChain);
    // Total duration is max end time = 15
    expect(player.getTotalDuration()).toBe(15);
  });

  it('should calculate total duration with staggered segments', async () => {
    // A: 0-10, B: 0-15, C: 10-20
    const mockChain = [
      { id: '1', audioUrl: 'http://test.com/1.webm', duration: 10, startTime: 0 },
      { id: '2', audioUrl: 'http://test.com/2.webm', duration: 15, startTime: 0 },
      { id: '3', audioUrl: 'http://test.com/3.webm', duration: 10, startTime: 10 },
    ];

    await player.loadChain(mockChain);
    // Total duration is max end time = 20 (segment 3 ends at 10+10=20)
    expect(player.getTotalDuration()).toBe(20);
  });
});

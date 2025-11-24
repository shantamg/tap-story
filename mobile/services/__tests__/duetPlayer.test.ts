import { DuetPlayer } from '../duetPlayer';

describe('DuetPlayer', () => {
  let player: DuetPlayer;

  beforeEach(() => {
    player = new DuetPlayer();
  });

  it('should load audio chain', async () => {
    const mockChain = [
      { id: '1', audioUrl: 'http://test.com/1.webm', duration: 5 },
      { id: '2', audioUrl: 'http://test.com/2.webm', duration: 3 },
    ];

    await player.loadChain(mockChain);
    expect(player.getTotalDuration()).toBe(8);
  });

  it('should play from specific position', async () => {
    const mockChain = [
      { id: '1', audioUrl: 'http://test.com/1.webm', duration: 5 },
      { id: '2', audioUrl: 'http://test.com/2.webm', duration: 3 },
    ];

    await player.loadChain(mockChain);
    await player.playFrom(6); // Start from 1 second into second audio

    const position = await player.getCurrentPosition();
    expect(position).toBeGreaterThanOrEqual(6);
  });
});

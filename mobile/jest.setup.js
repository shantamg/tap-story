// Jest setup file
jest.mock('expo-av', () => ({
  Audio: {
    Sound: {
      createAsync: jest.fn().mockImplementation((source, status) => {
        const startPosition = status?.positionMillis || 0;
        let localCheckCount = 0;

        const sound = {
          getStatusAsync: jest.fn().mockImplementation(() => {
            localCheckCount++;
            // Finish after just 2 checks to allow test to complete quickly
            const didJustFinish = localCheckCount > 2;

            return Promise.resolve({
              isLoaded: true,
              positionMillis: startPosition,
              didJustFinish,
            });
          }),
          setOnPlaybackStatusUpdate: jest.fn(),
          playAsync: jest.fn(),
          stopAsync: jest.fn(),
          unloadAsync: jest.fn(),
        };
        return Promise.resolve({ sound });
      }),
    },
    setAudioModeAsync: jest.fn(),
  },
  AVPlaybackStatus: {},
}));

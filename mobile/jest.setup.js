const createMockSound = (initialStatus = {}) => {
  const positionMillis = initialStatus.positionMillis ?? 0;

  return {
    getStatusAsync: jest.fn().mockResolvedValue({
      isLoaded: true,
      positionMillis,
      didJustFinish: false,
    }),
    setOnPlaybackStatusUpdate: jest.fn(),
    setPositionAsync: jest.fn().mockResolvedValue(undefined),
    setRateAsync: jest.fn().mockResolvedValue(undefined),
    playAsync: jest.fn().mockResolvedValue(undefined),
    pauseAsync: jest.fn().mockResolvedValue(undefined),
    stopAsync: jest.fn().mockResolvedValue(undefined),
    unloadAsync: jest.fn().mockResolvedValue(undefined),
  };
};

jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    Recording: jest.fn().mockImplementation(() => ({
      prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
      startAsync: jest.fn().mockResolvedValue(undefined),
      stopAndUnloadAsync: jest.fn().mockResolvedValue({ durationMillis: 1234 }),
      getURI: jest.fn().mockReturnValue('file:///test/recording.m4a'),
    })),
    Sound: {
      createAsync: jest.fn().mockImplementation((_source, status) =>
        Promise.resolve({ sound: createMockSound(status) })
      ),
    },
    AndroidOutputFormat: { MPEG_4: 2, WEBM: 9 },
    AndroidAudioEncoder: { AAC: 3, DEFAULT: 0 },
    IOSOutputFormat: { MPEG4AAC: 'aac ' },
    IOSAudioQuality: { HIGH: 96 },
  },
  InterruptionModeAndroid: { DoNotMix: 1, DuckOthers: 2 },
  InterruptionModeIOS: { DoNotMix: 1, DuckOthers: 2, MixWithOthers: 0 },
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn().mockResolvedValue({
    exists: true,
    isDirectory: false,
    uri: 'file:///documents/audio/test.m4a',
    size: 1024,
  }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
  moveAsync: jest.fn().mockResolvedValue(undefined),
  downloadAsync: jest.fn().mockResolvedValue({
    status: 200,
    uri: 'file:///documents/audio/test.m4a',
  }),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

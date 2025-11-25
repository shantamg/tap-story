import { SafeAreaView, StyleSheet } from 'react-native';
import { DuetRecorder } from '../components/DuetRecorder';
import { colors } from '../utils/theme';

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <DuetRecorder />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
});

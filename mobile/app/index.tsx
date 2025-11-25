import { SafeAreaView, StyleSheet } from 'react-native';
import { DuetRecorder } from '../components/DuetRecorder';

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
    backgroundColor: '#fff',
  },
});

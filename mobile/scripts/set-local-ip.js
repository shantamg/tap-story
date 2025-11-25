const { execSync } = require('child_process');
const fs = require('fs');

try {
  const ip = execSync('ipconfig getifaddr en0').toString().trim();
  const line = `EXPO_PUBLIC_API_URL=http://${ip}:3000\n`;

  fs.writeFileSync('.env', line);
  console.log(`⇢ EXPO_PUBLIC_API_URL=${line.trim()}`);
  console.log('✅ Local IP address detected and set successfully!');
} catch (error) {
  console.error('❌ Failed to detect local IP address automatically.');
  console.error('Error:', error.message);
  console.log('\n📱 To use the development build, please manually set your local IP address:');
  console.log('1. Find your local IP address:');
  console.log('   - macOS: System Preferences > Network > Advanced > TCP/IP');
  console.log('   - Or run: ifconfig | grep "inet " | grep -v 127.0.0.1');
  console.log('2. Create or edit .env file with:');
  console.log('   EXPO_PUBLIC_API_URL=http://YOUR_IP_ADDRESS:3000');
  console.log('3. Replace YOUR_IP_ADDRESS with your actual local IP (e.g., 192.168.1.100)');
  process.exit(1);
}

import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.reproductor.musica',
  appName: 'Reproductor de Música',
  webDir: 'dist-web',
  server: {
    androidScheme: 'https'
  }
}

export default config

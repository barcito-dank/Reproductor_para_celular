import { describe, it, expect, beforeEach } from 'vitest'
import { StorageVaultService } from '../src/renderer/src/services/StorageVaultService'
import {
  extractMediaMetadata,
  parseId3v2Tags,
  detectMediaType
} from '../src/renderer/src/services/metadataExtractor'
import { mobileBridge } from '../src/renderer/src/services/mobileBridge'

/**
 * Construye un buffer ID3v2.3 sintético válido con TIT2 (título), TPE1 (artista), TALB (álbum) y APIC (portada JPEG)
 */
function buildSyntheticMp3WithId3(opts: {
  title: string
  artist: string
  album: string
  coverBytes?: Uint8Array
}): Uint8Array {
  const encodeTextFrame = (id: string, text: string): Uint8Array => {
    const strBytes = new TextEncoder().encode(text)
    const size = 1 + strBytes.length // 1 byte encoding (3 = UTF-8) + text
    const frame = new Uint8Array(10 + size)
    frame[0] = id.charCodeAt(0)
    frame[1] = id.charCodeAt(1)
    frame[2] = id.charCodeAt(2)
    frame[3] = id.charCodeAt(3)
    frame[4] = (size >>> 24) & 0xff
    frame[5] = (size >>> 16) & 0xff
    frame[6] = (size >>> 8) & 0xff
    frame[7] = size & 0xff
    frame[8] = 0
    frame[9] = 0
    frame[10] = 3 // UTF-8
    frame.set(strBytes, 11)
    return frame
  }

  const frames: Uint8Array[] = [
    encodeTextFrame('TIT2', opts.title),
    encodeTextFrame('TPE1', opts.artist),
    encodeTextFrame('TALB', opts.album)
  ]

  if (opts.coverBytes) {
    const mime = new TextEncoder().encode('image/jpeg')
    // encoding(1) + mime + \0(1) + picType(1) + desc\0(1) + imageBytes
    const payloadSize = 1 + mime.length + 1 + 1 + 1 + opts.coverBytes.length
    const apic = new Uint8Array(10 + payloadSize)
    apic[0] = 0x41 // 'A'
    apic[1] = 0x50 // 'P'
    apic[2] = 0x49 // 'I'
    apic[3] = 0x43 // 'C'
    apic[4] = (payloadSize >>> 24) & 0xff
    apic[5] = (payloadSize >>> 16) & 0xff
    apic[6] = (payloadSize >>> 8) & 0xff
    apic[7] = payloadSize & 0xff
    apic[10] = 0 // encoding ISO-8859-1
    apic.set(mime, 11)
    const afterMime = 11 + mime.length
    apic[afterMime] = 0 // null terminator mime
    apic[afterMime + 1] = 3 // front cover
    apic[afterMime + 2] = 0 // empty description null terminator
    apic.set(opts.coverBytes, afterMime + 3)
    frames.push(apic)
  }

  const totalFramesSize = frames.reduce((acc, f) => acc + f.length, 0)
  const out = new Uint8Array(10 + totalFramesSize + 32)
  // "ID3" v2.3
  out[0] = 0x49
  out[1] = 0x44
  out[2] = 0x33
  out[3] = 3
  out[4] = 0
  out[5] = 0
  // Synchsafe size
  out[6] = (totalFramesSize >>> 21) & 0x7f
  out[7] = (totalFramesSize >>> 14) & 0x7f
  out[8] = (totalFramesSize >>> 7) & 0x7f
  out[9] = totalFramesSize & 0x7f

  let offset = 10
  for (const f of frames) {
    out.set(f, offset)
    offset += f.length
  }

  return out
}

describe('StorageVaultService & Relational M:N Reference Counting', () => {
  const vault = StorageVaultService.getInstance()

  beforeEach(async () => {
    await vault.resetVault({ createDefaultAlbum: false })
  })

  it('crea un álbum por defecto automáticamente si la bóveda se inicializa vacía', async () => {
    const response = await vault.buildLibraryResponse({ ensureDefaultIfEmpty: true })
    expect(response.tree.length).toBe(1)
    expect(response.tree[0].type).toBe('album')
    expect(response.tree[0].name).toBe('Favoritos')
    expect(response.vaultStats.totalAlbums).toBe(1)
    expect(response.vaultStats.totalTracks).toBe(0)
  })

  it('crea álbumes y carpetas jerárquicas y soporta mover/renombrar nodos', async () => {
    const rockFolder = await vault.createNode({
      name: 'Rock Nacional',
      nodeType: 'folder'
    })
    const sodaAlbum = await vault.createNode({
      name: 'Signos',
      parentId: rockFolder.id,
      nodeType: 'album'
    })

    expect(vault.getNodeVirtualPath(rockFolder.id)).toBe('Rock Nacional')
    expect(vault.getNodeVirtualPath(sodaAlbum.id)).toBe('Rock Nacional/Signos')

    const renamed = await vault.renameNode(sodaAlbum.id, 'Canción Animal')
    expect(renamed.success).toBe(true)
    expect(renamed.newPath).toBe('Rock Nacional/Canción Animal')

    const moved = await vault.moveNode(sodaAlbum.id, '__ROOT__')
    expect(moved.success).toBe(true)
    expect(moved.newPath).toBe('Canción Animal')
  })

  it('inserta una canción física y la vincula a 3 álbumes distintos sin duplicar el registro maestro (M:N)', async () => {
    const alb1 = await vault.createNode({ name: 'Álbum 1', nodeType: 'album' })
    const alb2 = await vault.createNode({ name: 'Álbum 2', nodeType: 'album' })
    const alb3 = await vault.createNode({ name: 'Álbum 3', nodeType: 'album' })

    const fakeAudio = buildSyntheticMp3WithId3({
      title: 'De Música Ligera',
      artist: 'Soda Stereo',
      album: 'Canción Animal'
    })

    const { track } = await vault.importTrackToVault({
      file: fakeAudio,
      fileName: 'Soda Stereo - De Musica Ligera.mp3',
      albumIds: [alb1.id, alb2.id, alb3.id],
      duration: 213,
      skipDomDurationProbe: true
    })

    // Solo debe existir 1 registro maestro en la tabla tracks y 1 archivo físico
    expect(vault.getAllTracks().length).toBe(1)
    expect(vault.hasPhysicalTrackFile(track.file_path)).toBe(true)
    expect(vault.getTrackReferenceCount(track.id)).toBe(3)

    const lib = await vault.buildLibraryResponse({ ensureDefaultIfEmpty: false })
    expect(lib.vaultStats.totalTracks).toBe(1)
    expect(lib.vaultStats.totalAlbums).toBe(3)

    const uKey = `ino:${track.id}`
    expect(lib.songAlbumsIndex[uKey]).toBeDefined()
    expect(lib.songAlbumsIndex[uKey].albumIds).toHaveLength(3)
    expect(lib.songAlbumsIndex[uKey].albumNames).toEqual(
      expect.arrayContaining(['Álbum 1', 'Álbum 2', 'Álbum 3'])
    )

    // Cada pista en cada álbum conserva uniqueKey = ino:${track.id}
    for (const node of lib.tree) {
      expect(node.tracks).toHaveLength(1)
      expect(node.tracks![0].id).toBe(track.id)
      expect(node.tracks![0].uniqueKey).toBe(`ino:${track.id}`)
    }
  })

  it('aplica la Regla de Oro de conteo de referencias al eliminar en Álbum 1, 2 y finalmente 3', async () => {
    const alb1 = await vault.createNode({ name: 'Álbum 1', nodeType: 'album' })
    const alb2 = await vault.createNode({ name: 'Álbum 2', nodeType: 'album' })
    const alb3 = await vault.createNode({ name: 'Álbum 3', nodeType: 'album' })

    const fakeAudio = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4])
    const { track } = await vault.importTrackToVault({
      file: fakeAudio,
      fileName: 'Persiana Americana.mp3',
      title: 'Persiana Americana',
      artist: 'Soda Stereo',
      albumIds: [alb1.id, alb2.id, alb3.id],
      duration: 290,
      skipDomDurationProbe: true
    })

    await vault.saveTrackLyrics(track.id, '[00:10.00] Yo te prefiero fuera de foco')

    // 1. Eliminar del Álbum 1 -> ref_count pasa a 2, el archivo maestro SIGUE existiendo
    const del1 = await vault.deleteTrackFromAlbum({
      trackId: track.id,
      albumId: alb1.id,
      deleteAllCopies: false
    })
    expect(del1.success).toBe(true)
    expect(del1.remainingReferences).toBe(2)
    expect(del1.masterDeleted).toBe(false)
    expect(del1.physicalFileDeleted).toBe(false)
    expect(vault.getTrackById(track.id)).not.toBeNull()
    expect(vault.hasPhysicalTrackFile(track.file_path)).toBe(true)

    // 2. Eliminar del Álbum 2 -> ref_count pasa a 1, el archivo maestro SIGUE existiendo
    const del2 = await vault.deleteTrackFromAlbum({
      trackId: track.id,
      albumId: alb2.id,
      deleteAllCopies: false
    })
    expect(del2.success).toBe(true)
    expect(del2.remainingReferences).toBe(1)
    expect(del2.masterDeleted).toBe(false)
    expect(del2.physicalFileDeleted).toBe(false)
    expect(vault.getTrackById(track.id)).not.toBeNull()
    expect(vault.hasPhysicalTrackFile(track.file_path)).toBe(true)

    // 3. Eliminar del Álbum 3 -> ref_count llega a 0 -> se borra registro maestro, .lrc y archivo físico automáticamente
    const del3 = await vault.deleteTrackFromAlbum({
      trackId: track.id,
      albumId: alb3.id,
      deleteAllCopies: false
    })
    expect(del3.success).toBe(true)
    expect(del3.remainingReferences).toBe(0)
    expect(del3.masterDeleted).toBe(true)
    expect(del3.physicalFileDeleted).toBe(true)
    expect(vault.getTrackById(track.id)).toBeNull()
    expect(vault.hasPhysicalTrackFile(track.file_path)).toBe(false)
    expect(await vault.readTrackLyrics(track.id)).toBeNull()
  })

  it('elimina inmediatamente todas las copias y el archivo físico cuando deleteAllCopies = true', async () => {
    const alb1 = await vault.createNode({ name: 'Gym', nodeType: 'album' })
    const alb2 = await vault.createNode({ name: 'Viaje', nodeType: 'album' })
    const alb3 = await vault.createNode({ name: 'Clásicos', nodeType: 'album' })

    const fakeAudio = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1])
    const { track } = await vault.importTrackToVault({
      file: fakeAudio,
      fileName: 'Prófugos.flac',
      title: 'Prófugos',
      artist: 'Soda Stereo',
      albumIds: [alb1.id, alb2.id, alb3.id],
      duration: 318,
      skipDomDurationProbe: true
    })

    expect(vault.getTrackReferenceCount(track.id)).toBe(3)
    expect(vault.hasPhysicalTrackFile(track.file_path)).toBe(true)

    const delAll = await vault.deleteTrackFromAlbum({
      trackId: track.id,
      deleteAllCopies: true
    })

    expect(delAll.success).toBe(true)
    expect(delAll.remainingReferences).toBe(0)
    expect(delAll.masterDeleted).toBe(true)
    expect(delAll.physicalFileDeleted).toBe(true)
    expect(vault.getTrackReferenceCount(track.id)).toBe(0)
    expect(vault.getTrackById(track.id)).toBeNull()
    expect(vault.hasPhysicalTrackFile(track.file_path)).toBe(false)
  })

  it('extrae tags ID3v2, deduplica carátulas por hash y funciona a través de mobileBridge', async () => {
    const coverImg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9
    ])

    const mp3Buffer = buildSyntheticMp3WithId3({
      title: 'En la Ciudad de la Furia',
      artist: 'Soda Stereo',
      album: 'Doble Vida',
      coverBytes: coverImg
    })

    const id3 = parseId3v2Tags(mp3Buffer)
    expect(id3.title).toBe('En la Ciudad de la Furia')
    expect(id3.artist).toBe('Soda Stereo')
    expect(id3.album).toBe('Doble Vida')
    expect(id3.coverBytes).toBeDefined()

    const meta = await extractMediaMetadata(mp3Buffer, {
      fileName: 'ciudad.mp3',
      skipDomDurationProbe: true
    })
    expect(meta.title).toBe('En la Ciudad de la Furia')
    expect(meta.artist).toBe('Soda Stereo')
    expect(meta.coverHash).toBeTruthy()
    expect(detectMediaType('concierto.mp4')).toBe('video')
    expect(detectMediaType('cancion.opus')).toBe('audio')

    // Probar operaciones desde mobileBridge
    const createRes = await mobileBridge.createAlbum({ albumName: 'Doble Vida' })
    expect(createRes.success).toBe(true)

    const { track } = await vault.importTrackToVault({
      file: mp3Buffer,
      fileName: 'ciudad.mp3',
      albumIds: [createRes.albumId!],
      duration: 345,
      skipDomDurationProbe: true
    })

    const health = await mobileBridge.checkHardlinksHealth()
    expect(health.success).toBe(true)
    expect(health.healthy).toBe(true)
    expect(health.totalMasterFiles).toBe(1)
    expect(health.totalOrganizedFiles).toBe(1)

    const delBridgeRes = await mobileBridge.deleteTrackFile({
      trackId: track.id,
      albumId: createRes.albumId,
      deleteAllCopies: false
    })
    expect(delBridgeRes.success).toBe(true)
    expect(vault.getAllTracks().length).toBe(0)
  })
})

import fs from 'fs'
import path from 'path'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'])

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function collectAudioFiles(dir) {
  const results = []
  async function walk(current) {
    try {
      const entries = await fs.promises.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (AUDIO_EXTENSIONS.has(ext)) {
            try {
              const stat = await fs.promises.stat(fullPath, { bigint: true })
              results.push({
                path: fullPath,
                name: entry.name,
                ino: stat.ino.toString(),
                nlink: Number(stat.nlink),
                size: Number(stat.size)
              })
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }
  await walk(dir)
  return results
}

/**
 * Diagnostica la integridad de los Hard Links NTFS entre canciones_organizadas y Canciones_reales
 */
export async function runHardlinksHealthCheck(musicDir, realMusicDir) {
  try {
    await fs.promises.access(musicDir)
  } catch (_) {
    return { success: false, error: 'Directorio de música no encontrado' }
  }

  try {
    await fs.promises.mkdir(realMusicDir, { recursive: true })
  } catch (_) {}

  const organizedFiles = await collectAudioFiles(musicDir)
  const masterFiles = await collectAudioFiles(realMusicDir)

  const masterInoMap = new Map() // ino -> masterFile
  const masterNameMap = new Map() // name.toLowerCase() -> masterFile

  for (const m of masterFiles) {
    masterInoMap.set(m.ino, m)
    masterNameMap.set(m.name.toLowerCase(), m)
  }

  let healthyCount = 0
  let unlinkedCount = 0
  let divergentCount = 0
  const issues = []

  // Calcular espacio ahorrado por Hard Links
  const inoOccurrences = new Map()
  for (const file of organizedFiles) {
    const prev = inoOccurrences.get(file.ino) || { count: 0, size: file.size, name: file.name }
    prev.count += 1
    inoOccurrences.set(file.ino, prev)

    const hasMatchingIno = masterInoMap.has(file.ino)
    const matchingByName = masterNameMap.get(file.name.toLowerCase())

    if (hasMatchingIno) {
      healthyCount++
    } else if (matchingByName && matchingByName.ino !== file.ino) {
      divergentCount++
      issues.push({
        type: 'divergent',
        filePath: file.path,
        fileName: file.name,
        masterPath: matchingByName.path,
        message: `Inodo divergente con Canciones_reales para "${file.name}"`
      })
    } else {
      unlinkedCount++
      issues.push({
        type: 'unlinked',
        filePath: file.path,
        fileName: file.name,
        message: `Sin archivo maestro correspondiente en Canciones_reales: "${file.name}"`
      })
    }
  }

  let savedSpaceBytes = 0
  for (const [, info] of inoOccurrences) {
    // Si la pista aparece en N álbumes, ahorra (N - 1) copias físicas completas
    if (info.count > 1) {
      savedSpaceBytes += (info.count - 1) * info.size
    }
  }

  const total = organizedFiles.length
  const healthPercentage = total > 0 ? Math.round((healthyCount / total) * 100) : 100

  return {
    success: true,
    totalOrganizedFiles: total,
    totalMasterFiles: masterFiles.length,
    healthyCount,
    unlinkedCount,
    divergentCount,
    healthPercentage,
    savedSpaceBytes,
    savedSpaceFormatted: formatBytes(savedSpaceBytes),
    issues: issues.slice(0, 50)
  }
}

/**
 * Auto-repara y sincroniza inodos creando los enlaces duros faltantes hacia Canciones_reales
 */
export async function repairHardlinksIntegrity(musicDir, realMusicDir) {
  const check = await runHardlinksHealthCheck(musicDir, realMusicDir)
  if (!check.success) return check

  let repairedCount = 0

  for (const issue of check.issues) {
    try {
      if (issue.type === 'divergent' && issue.masterPath) {
        // Unificar inodos preservando archivo maestro
        await fs.promises.unlink(issue.filePath)
        await fs.promises.link(issue.masterPath, issue.filePath)
        repairedCount++
      } else if (issue.type === 'unlinked') {
        const destMaster = path.join(realMusicDir, issue.fileName)
        try {
          await fs.promises.access(destMaster)
          // Ya existe en destino con otro nombre o inodo; re-enlazar
          await fs.promises.unlink(issue.filePath)
          await fs.promises.link(destMaster, issue.filePath)
        } catch (_) {
          // Crear copia/enlace maestro en Canciones_reales
          await fs.promises.link(issue.filePath, destMaster)
        }
        repairedCount++
      }
    } catch (err) {
      console.warn(`Error reparando archivo ${issue.fileName}:`, err.message)
    }
  }

  return {
    success: true,
    repairedCount,
    previousHealthyCount: check.healthyCount
  }
}

import { Client } from 'basic-ftp'
import { ServerEntry } from './config'

export interface FtpSizeResult {
  server: ServerEntry
  size: number | null
  error?: string
}

// Connects to a single server's FTP and grabs the save file's size in bytes.
export async function fetchSaveSize(server: ServerEntry): Promise<FtpSizeResult> {
  const client = new Client(15_000) // give up after 15 seconds if the server isn't responding
  try {
    await client.access({
      host: server.host,
      port: server.port,
      user: server.user,
      password: server.password,
      secure: false,
    })

    const files = await client.list(server.savePath)
    const saveFile = files.find(f => f.name === server.saveFile)

    if (!saveFile) {
      return { server, size: null, error: `Save file "${server.saveFile}" not found in ${server.savePath}` }
    }

    return { server, size: saveFile.size }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { server, size: null, error: `FTP error for ${server.name}: ${msg}` }
  } finally {
    client.close()
  }
}

// Checks all servers at the same time (parallel) and returns their save file sizes.
export async function fetchAllSizes(servers: ServerEntry[]): Promise<FtpSizeResult[]> {
  return Promise.all(servers.map(fetchSaveSize))
}

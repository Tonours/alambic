import os from 'node:os'
import path from 'node:path'

export function alambicStateDir(xdgStateHome, env = process.env) {
  if (xdgStateHome) return path.resolve(xdgStateHome, 'alambic')
  if (env.ALAMBIC_STATE_DIR) {
    if (!path.isAbsolute(env.ALAMBIC_STATE_DIR)) throw new Error('ALAMBIC_STATE_DIR must be an absolute path')
    return path.resolve(env.ALAMBIC_STATE_DIR)
  }
  return path.resolve(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'alambic')
}

import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from '../../../../sqlite/sqliteNativeRuntime'

export type ShardSqliteOpener = (dbPath: string) => SqliteNativeRuntimeFacade

export function openShardSqliteNode(dbPath: string): SqliteNativeRuntimeFacade {
  return openSqliteRuntime({ dbPath })
}

/** 移动端：sqlite-engine 组件的 sql.js；dbPath 需映射为 vault 相对路径。 */
export function openShardSqliteWasm(
  _dbPath: string,
): SqliteNativeRuntimeFacade {
  // acquireRuntimeComponent('sqlite-engine') → openSqliteJsRuntime({ relativePath, adapter })
  // 实现于 Task 6 完善真实 adapter 解析；本任务先建立签名 + 桌面路径测试
  throw new Error('openShardSqliteWasm is wired in Task 6')
}

import { useSyncExternalStore } from 'react'

import type { DatabaseMaintenanceController } from '../../../core/maintenance/DatabaseMaintenanceController'
import type { MaintenanceSnapshot } from '../../../core/maintenance/types'

export const useDatabaseMaintenanceProjection = (
  controller: DatabaseMaintenanceController,
): MaintenanceSnapshot =>
  useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  )

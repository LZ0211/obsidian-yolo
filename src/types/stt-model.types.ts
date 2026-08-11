import { z } from 'zod'

export const sttModelSchema = z.object({
  providerId: z.string().min(1, 'provider ID is required'),
  id: z.string().min(1, 'id is required'),
  model: z.string().min(1, 'model is required'),
  name: z.string().optional(),
})

export type SttModel = z.infer<typeof sttModelSchema>

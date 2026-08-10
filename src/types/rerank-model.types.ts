import { z } from 'zod'

const optionalPositiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional()

export const rerankModelSchema = z.object({
  providerId: z
    .string({
      required_error: 'provider ID is required',
    })
    .min(1, 'provider ID is required'),
  id: z
    .string({
      required_error: 'id is required',
    })
    .min(1, 'id is required'),
  model: z
    .string({
      required_error: 'model is required',
    })
    .min(1, 'model is required'),
  name: z.string().optional(),
  maxDocuments: optionalPositiveSafeInteger,
  maxInputChars: optionalPositiveSafeInteger,
})

export type RerankModel = z.infer<typeof rerankModelSchema>

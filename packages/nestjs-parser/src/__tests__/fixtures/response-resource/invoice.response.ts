// @ts-nocheck
import { Expose, Exclude } from 'class-transformer'

@Exclude()
export class InvoiceResponseDto {
  @Expose()
  id: number

  @Expose()
  total: number

  @Expose()
  status: string

  // NOT exposed — internal field
  internalNotes: string

  // Sensitive — exposed but flagged
  @Expose()
  apiKey: string
}

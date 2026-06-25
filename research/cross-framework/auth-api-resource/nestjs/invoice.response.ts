// @ts-nocheck
import { Expose, Exclude } from 'class-transformer'

@Exclude()
export class InvoiceResponseDto {
  @Expose() id: number
  @Expose() total: number
  @Expose() status: string
}

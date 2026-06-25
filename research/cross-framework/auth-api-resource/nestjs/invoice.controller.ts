// @ts-nocheck
import { Controller, Get, Param, UseGuards } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { JwtAuthGuard } from './jwt-auth.guard'
import { InvoiceResponseDto } from './invoice.response'

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoiceController {
  @Get(':id')
  async show(@Param('id') id: string) {
    const invoice = { id: Number(id), total: 250, status: 'paid' }
    return plainToInstance(InvoiceResponseDto, invoice)
  }
}

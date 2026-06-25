// @ts-nocheck
import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { JwtAuthGuard } from './jwt-auth.guard'
import { InvoiceResponseDto } from './invoice.response'

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoiceController {
  // Signal 1: plainToInstance call
  @Post()
  async store() {
    const invoice = { id: 1, total: 100, status: 'paid', internalNotes: 'x', apiKey: 'sk-123' }
    return plainToInstance(InvoiceResponseDto, invoice)
  }

  // Signal 2: return type annotation
  @Get(':id')
  async show(@Param('id') id: string): Promise<InvoiceResponseDto> {
    return { id: Number(id), total: 100, status: 'paid', internalNotes: 'x', apiKey: 'sk-123' }
  }
}

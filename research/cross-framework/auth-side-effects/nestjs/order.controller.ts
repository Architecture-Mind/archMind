// @ts-nocheck
import { Controller, Post, UseGuards } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bull'
import { Queue } from 'bull'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { JwtAuthGuard } from './jwt-auth.guard'

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(
    @InjectQueue('invoice') private readonly invoiceQueue: Queue,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Post()
  async store() {
    await this.invoiceQueue.add('generate-invoice', {})
    this.eventEmitter.emit('order.created', {})
    return { status: 'created' }
  }
}

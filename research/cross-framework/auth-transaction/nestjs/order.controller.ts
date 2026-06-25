// @ts-nocheck
import { Controller, Post, Body, UseGuards } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { JwtAuthGuard } from './jwt-auth.guard'

@Controller('orders')
export class OrderController {
  constructor(private readonly dataSource: DataSource) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async store(@Body() dto: CreateOrderDto) {
    await this.dataSource.transaction(async (manager) => {
      const order   = await manager.save(Order, dto)
      const payment = await manager.save(Payment, { orderId: order.id, amount: dto.total })
    })
    return { created: true }
  }
}

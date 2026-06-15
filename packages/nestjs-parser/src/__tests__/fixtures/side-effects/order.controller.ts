// @ts-nocheck
// NestJS fixture — tests side-effect extraction (queue, event, mail)

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(
    @InjectQueue('pdf-generation') private readonly pdfQueue: Queue,
    private readonly eventEmitter: EventEmitter2,
    private readonly mailerService: MailerService,
  ) {}

  // Dispatches a queue job + emits an event
  @Post()
  async create(@Body() dto: CreateOrderDto) {
    const order = await this.orderService.create(dto)
    await this.pdfQueue.add('generate-invoice', { orderId: order.id })
    this.eventEmitter.emit('order.created', order)
    return order
  }

  // Sends a synchronous mail
  @Post(':id/notify')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async notify(@Param('id') id: string) {
    await this.mailerService.sendMail({
      to: 'user@example.com',
      subject: 'Order confirmed',
    })
    return { sent: true }
  }

  // No side effects — plain read
  @Get(':id')
  findOne(@Param('id') id: string) {
    return null
  }
}

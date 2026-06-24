// @ts-nocheck
// NestJS fixture — tests ir:notification extraction

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserNotificationController {
  constructor(
    private readonly notificationService: NotificationService,
  ) {}

  // Sends a push notification
  @Post(':id/notify')
  async notify(@Param('id') id: string) {
    await this.notificationService.send('welcome', { userId: id })
    return { sent: true }
  }
}

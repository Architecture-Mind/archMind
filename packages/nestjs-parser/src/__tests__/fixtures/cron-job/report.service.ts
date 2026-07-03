// @ts-nocheck
// NestJS fixture — no @nestjs/* packages needed; ts-morph parses syntax only

@Injectable()
export class ReportService {

  constructor(private readonly reportRepository: ReportRepository) {}

  @Cron('0 0 * * * *')
  generateHourlyReport() {
    this.reportRepository.save({});
  }

  // Non-cron method — must NOT be picked up as an entrypoint
  helper() { return null; }
}

// @ts-nocheck
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { DataSource } from 'typeorm'

@Injectable()
export class ReportService {
  constructor(private readonly dataSource: DataSource) {}

  @Cron('0 0 * * * *')
  async generateHourlyReport() {
    await this.dataSource.transaction(async (manager) => {
      await manager.save(Report, {})
    })
  }
}

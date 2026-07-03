package com.example.jobs;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
public class ReportJob {
  private final ReportRepository reportRepository;

  public ReportJob(ReportRepository reportRepository) {
    this.reportRepository = reportRepository;
  }

  @Scheduled(cron = "0 0 * * * *")
  @Transactional
  public void generateHourlyReport() {
    reportRepository.save(new Report());
  }
}

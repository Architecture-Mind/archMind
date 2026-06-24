// @ts-nocheck
import { Controller, Get, Param, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from './jwt-auth.guard'
import { TaskService } from './task.service'

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get(':id')
  show(@Param('id') id: string) {
    return this.taskService.findById(id)
  }
}

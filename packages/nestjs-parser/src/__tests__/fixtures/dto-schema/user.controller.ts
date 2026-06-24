// @ts-nocheck
import { Controller, Post, Body, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from './jwt-auth.guard'
import { CreateUserDto } from './create-user.dto'

@Controller('users')
export class UserController {
  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateUserDto) {
    return { created: true }
  }
}

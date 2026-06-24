// @ts-nocheck
import { IsEmail, IsString, IsNotEmpty, MinLength, IsOptional, IsInt, Min, Max } from 'class-validator'

export class CreateUserDto {
  @IsEmail()
  email: string

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name: string

  @IsString()
  @MinLength(8)
  password: string

  @IsOptional()
  @IsInt()
  @Min(18)
  @Max(120)
  age: number
}

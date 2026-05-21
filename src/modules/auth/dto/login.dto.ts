import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ description: 'Dashboard login email', example: 'admin@rhalla.wa' })
  @IsString()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Dashboard login password' })
  @IsString()
  @IsNotEmpty()
  password: string;
}

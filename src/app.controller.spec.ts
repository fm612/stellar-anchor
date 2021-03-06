import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from 'nestjs-config';
import * as path from 'path';
import { WalletsModule } from './wallets/wallets.module';
import { RedisModule, RedisService } from 'nestjs-redis';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      imports: [
        ConfigModule.load(
          path.resolve(__dirname, 'config/**/!(*.d).{ts,js}'),
          {path: process.cwd() + '/' + (process.env.NODE_ENV || '') + '.env'},
        ),
        RedisModule.forRootAsync({
          useFactory: (configService: ConfigService) => configService.get('redis'),
          inject: [ConfigService],
        }),
        WalletsModule,
      ],
      providers: [AppService,
        { provide: RedisService, useValue: {}},
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });

    it('should generate stellar.toml', () => {
      const fakeReq = {headers: {host: 'https://apay.io'}};
      const response = appController.getStellarToml(fakeReq);

      expect(response).toContain('TRANSFER_SERVER="https://apay.io"');
      expect(response).toContain('[[CURRENCIES]]');
      expect(response).toContain('status="live"');
    });

    it('should validate address', async () => {
      const response = await appController.validateDestination({
        asset_code: 'TBTC',
        dest: '2N1SYvx6bncD6XRKvmJUKQua6n66agZ5X3n',
      });

      expect(response).toEqual(true);

      const response2 = await appController.validateDestination({
        asset_code: 'TBTC',
        dest: '2N1SYvx6bncD6XRKvmJUKQua6n66agZ5X3',
      });

      expect(response2).toEqual(false);
    });
  });
});

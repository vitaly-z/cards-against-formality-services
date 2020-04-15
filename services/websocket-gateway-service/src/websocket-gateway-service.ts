import ApiGateway from 'moleculer-web';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import redis from 'socket.io-redis';
import SocketIO from 'socket.io';
import DefaultNamespace from './DefaultNamespace';
import GameNamespace from './GameNamespace';
import RoomsNamespace from './RoomsNamespace';

/**
 * WebsocketGatewayService exposes all access to websocket users.
 *
 * @export
 * @class WebsocketGatewayService
 * @extends {Service}
 */
export default class WebsocketGatewayService extends Service {

  /**
   * SocketIO server.
   *
   * @private
   * @type {SocketIO.Server}
   * @memberof WebsocketGatewayService
   */
  private socketServer: SocketIO.Server = null;

  /**
   * Creates an instance of WebsocketGatewayService.
   *
   * @param {ServiceBroker} _broker
   * @memberof WebsocketGatewayService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'websocket-gateway',
        mixins: [
          ApiGateway
        ],
        settings: {
          use: [
            compression(),
            cookieParser(),
          ]
        },
        started: () => {
          this.socketServer = SocketIO(this.server, { path: '/socket' });
          this.socketServer.adapter(redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }));
          new DefaultNamespace(this.socketServer.of('/'), this.broker, this.logger);
          new RoomsNamespace(this.socketServer.of('/rooms'), this.broker, this.logger);
          // Handles users joining a game room of roomId.
          new GameNamespace(this.socketServer.of('/games'), this.broker, this.logger);
          return null;
        },
        actions: {
          health: this.health
        },
        events: {
          'rooms.created': ctx => this.emitRoomUpdate(ctx, 'created'),
          'rooms.updated': ctx => this.emitRoomUpdate(ctx, 'updated'),
          'rooms.removed': ctx => this.emitRoomUpdate(ctx, 'removed'),
          'games.updated': ctx => this.handleGameUpdate(ctx),
          'games.deal': ctx => this.handleCardDealing(ctx)
        }
      }
    );
  }

  private emit(ctx: Context<any>, namespace: string, event: string, updateType: string) {
    this.socketServer.nsps[namespace].emit(event, { updateType, payload: ctx.params });
  }

  private emitRoomUpdate(ctx: Context<any>, updateType: string) {
    this.emit(ctx, '/rooms', 'rooms', updateType);
    this.sendRoomChangeToGame(ctx, updateType);
  }

  private async sendRoomChangeToGame(ctx: Context<any>, updateType: string) {
    const room = Object.assign({}, ctx.params);

    // Get clients from cache, This should have a smaller time complexity than making one request and reducing.
    const players = await ctx.call('clients.get', { id: room.players, fields: ['displayName', '_id'] });
    const spectators = await ctx.call('clients.get', { id: room.spectators, fields: ['displayName', '_id'] });
    room.players = players;
    room.spectators = spectators;

    this.socketServer.nsps['/games'].to(ctx.params._id).emit('room', { updateType, payload: room });
  }

  private async handleCardDealing(ctx: Context<{ clientId: string; cards: any[] }>) {
    const { clientId, cards } = ctx.params;
    const client: any = await ctx.call('clients.get', { id: clientId });
    const socketId = `/games#${client.socket}`;
    this.socketServer.nsps['/games'].to(socketId).emit('deal', { payload: cards });
  }

  private handleGameUpdate(ctx: Context<any>) {
    // Only emit to the players in the room associated with the game.
    this.socketServer.nsps['/games'].to(ctx.params.roomId).emit('game', { payload: ctx.params });
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof WebsocketGatewayService
   */
  private health(ctx: Context): Promise<NodeHealthStatus> {
    return ctx.call('$node.health');
  }
}

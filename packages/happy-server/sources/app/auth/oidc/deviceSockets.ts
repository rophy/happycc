import type { Server } from 'socket.io';

let io: Server | null = null;

export function setSocketServer(server: Server): void {
    io = server;
}

export function deviceRoom(deviceId: string): string {
    return `device:${deviceId}`;
}

/** Disconnects every socket (on any node, via the adapter) opened with this device's token. */
export function disconnectDeviceSockets(deviceId: string): void {
    io?.in(deviceRoom(deviceId)).disconnectSockets(true);
}

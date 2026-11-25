'use client';

import { useParams } from 'next/navigation';
import RoomGate from '../../../components/RoomGate';

export default function RoomPage() {
  const params = useParams();
  return <RoomGate rawRoomId={String(params.roomId || '')} />;
}

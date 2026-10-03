import * as React from 'react';
import { Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

import { NOT_AVAILABLE_IN_BUILD, WORKSTATION_ONLY_START_HINT } from './workstationOnlyText';

/**
 * The screen a route renders when the workstation-only build disables it
 * (starting sessions, machine screens). A link to it still lands somewhere
 * readable instead of a working screen.
 */
export function NotAvailableInBuild() {
    const { theme } = useUnistyles();
    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: '' }} />
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, backgroundColor: theme.colors.groupped.background }}>
                <Text style={[Typography.default('semiBold'), { fontSize: 17, color: theme.colors.text, textAlign: 'center' }]}>
                    {NOT_AVAILABLE_IN_BUILD}
                </Text>
                <Text style={[Typography.default(), { fontSize: 15, marginTop: 8, color: theme.colors.textSecondary, textAlign: 'center' }]}>
                    {WORKSTATION_ONLY_START_HINT}
                </Text>
            </View>
        </>
    );
}

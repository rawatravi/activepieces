import { createAction, Property, Validators } from "@activepieces/pieces-framework";
import { ExecutionType, PauseType } from "@activepieces/shared";


export const WaitForAction = createAction({
    name: 'WaitFor',
    displayName: 'Wait For User Response',
    description: 'Wait For User Response For Chat or webhook',
    props: {
    },
    async run(ctx) {
        if (ctx.executionType === ExecutionType.BEGIN) {
            ctx.run.pause({
                pauseMetadata: {
                    type: PauseType.USER_RESPONSE,
                    usermessage: '',
                }
            });
            return {}
        }
        else {
            const payload = ctx.resumePayload as { usermessage: string };
            console.log(payload,"+++++++++++++++++++++++++++++++++++++++++++++++++")
            return {
                usermessage: payload.usermessage,
            }
        }
    }
});
